"use strict";

/**
 * currencyConversionService — converts XLM and USDC amounts to local currency.
 *
 * Design decisions (Issue #796):
 *   - Primary provider: CoinGecko (/simple/price).
 *   - Secondary provider: Coinbase Exchange (/exchange-rates) — used
 *     automatically when CoinGecko fails or returns invalid data.
 *   - Redis-backed shared cache (keyed by `currency:rates:<CURRENCY>`).
 *     Falls back to in-process Map when Redis is unavailable, so each replica
 *     does not independently hammer the price feed.
 *   - All logging via logger.child('CurrencyConversion') — no console.warn.
 *   - Prometheus gauges: price_feed_available{provider} and
 *     price_feed_staleness_seconds{provider}.
 *   - Stale-while-revalidate: serve stale cache when both providers fail,
 *     up to PRICE_STALE_THRESHOLD_MS (default 1 hour).
 *
 * Fix #892: decimal-safe multiplication via decimal.js; per-currency decimal
 *   precision honours ISO 4217 (e.g. JPY = 0 dp, KWD = 3 dp, USD = 2 dp).
 */

const https   = require("https");
const Decimal = require("decimal.js");
const client = require("prom-client");
const { getRedisClient, isRedisReady } = require("../config/redisClient");
const logger = require("../utils/logger").child("CurrencyConversion");

// ── Per-currency decimal precision (ISO 4217) ─────────────────────────────────
//
// Most currencies use 2 decimal places.  Exceptions are listed here so that
// amounts in zero-decimal currencies (JPY, KRW …) are never shown as "¥1.23"
// and amounts in 3-decimal currencies (KWD, BHD …) are not under-rounded.
//
// Source: ISO 4217 minor unit definitions.
//
// CoinGecko response contract (documented here for #893):
//   GET /api/v3/simple/price?ids=stellar,usd-coin&vs_currencies=<CURRENCY>
//   {
//     "stellar":   { "<lc_currency>": <number> },   // XLM rate
//     "usd-coin":  { "<lc_currency>": <number> }    // USDC rate
//   }
//   Both keys MUST be present and their values MUST be positive finite numbers.
const CURRENCY_DECIMALS = {
  // 0 decimal places
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  MGA: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimal places
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // default is 2 — not listed here
};

/**
 * Multiply `amount` by `rate` using decimal-safe arithmetic and round to the
 * correct number of decimal places for `currency`.
 *
 * Returns a plain JS number suitable for JSON serialisation. Uses
 * ROUND_HALF_UP to match the expectation of most financial displays.
 *
 * @param {number|string} amount
 * @param {number|string} rate
 * @param {string}        currency  - ISO 4217 code (e.g. "USD", "JPY")
 * @returns {number}
 */
function _decimalMultiply(amount, rate, currency) {
  const dp = CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;
  return new Decimal(amount)
    .times(new Decimal(rate))
    .toDecimalPlaces(dp, Decimal.ROUND_HALF_UP)
    .toNumber();
}

// ── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS             = parseInt(process.env.PRICE_CACHE_TTL_MS        || "60000",  10);
const PRICE_STALE_THRESHOLD_MS = parseInt(process.env.PRICE_STALE_THRESHOLD_MS  || "3600000", 10);
const COINGECKO_API_KEY        = process.env.COINGECKO_API_KEY || null;

// Redis cache TTL in seconds (slightly longer than in-memory TTL to allow
// cross-replica stale-while-revalidate).
const REDIS_CACHE_TTL_S = Math.ceil(PRICE_STALE_THRESHOLD_MS / 1000);

// ── Prometheus metrics ───────────────────────────────────────────────────────

let _metricsInitialized = false;
let priceFeedAvailable;
let priceFeedStaleness;

function _initMetrics() {
  if (_metricsInitialized) return;
  try {
    // Attempt to use the shared registry if metrics/index already initialized it.
    const { registry } = require("../metrics/index");

    priceFeedAvailable = new client.Gauge({
      name: "price_feed_available",
      help: "1 if the price feed provider is available, 0 otherwise",
      labelNames: ["provider"],
      registers: [registry],
    });

    priceFeedStaleness = new client.Gauge({
      name: "price_feed_staleness_seconds",
      help: "Seconds since the last successful price fetch per provider",
      labelNames: ["provider"],
      registers: [registry],
    });

    _metricsInitialized = true;
  } catch (_) {
    // metrics/index not loaded yet — will be initialized lazily on first use
  }
}

function _recordAvailable(provider, available) {
  _initMetrics();
  if (priceFeedAvailable) priceFeedAvailable.set({ provider }, available ? 1 : 0);
}

function _recordStaleness(provider, lastSuccessfulFetchMs) {
  _initMetrics();
  if (priceFeedStaleness && lastSuccessfulFetchMs) {
    priceFeedStaleness.set({ provider }, Math.floor((Date.now() - lastSuccessfulFetchMs) / 1000));
  }
}

// ── In-process cache (fallback when Redis unavailable) ───────────────────────
// Structure: Map<CURRENCY, { rates, fetchedAt (ms), lastSuccessfulFetch (ms) }>

const _localCache = new Map();

// ── In-flight deduplication ──────────────────────────────────────────────────
const _inFlight = new Map();

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`HTTP ${res.statusCode} from price feed`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Invalid JSON from price feed")); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Price feed request timed out")); });
    req.on("error", reject);
  });
}

// ── Provider: CoinGecko ───────────────────────────────────────────────────────

async function _fetchFromCoinGecko(currency) {
  let url =
    "https://api.coingecko.com/api/v3/simple/price" +
    `?ids=stellar%2Cusd-coin&vs_currencies=${encodeURIComponent(currency)}`;
  if (COINGECKO_API_KEY) url += `&x_cg_pro_api_key=${encodeURIComponent(COINGECKO_API_KEY)}`;

  const data = await httpsGet(url);
  const xlmRate  = data?.stellar?.["" + currency];
  const usdcRate = data?.["usd-coin"]?.["" + currency];

  if (typeof xlmRate !== "number" || xlmRate <= 0)
    throw new Error(`CoinGecko: no valid XLM rate for "${currency}"`);
  if (typeof usdcRate !== "number" || usdcRate <= 0)
    throw new Error(`CoinGecko: no valid USDC rate for "${currency}"`);

  return { XLM: xlmRate, USDC: usdcRate };
}

// ── Provider: Coinbase Exchange ───────────────────────────────────────────────
// Uses /exchange-rates?currency=XLM and /exchange-rates?currency=USDC.
// Coinbase returns fiat rates for any supported vs_currency.

async function _fetchFromCoinbase(currency) {
  const [xlmData, usdcData] = await Promise.all([
    httpsGet(`https://api.coinbase.com/v2/exchange-rates?currency=XLM`),
    httpsGet(`https://api.coinbase.com/v2/exchange-rates?currency=USDC`),
  ]);

  const xlmRate  = parseFloat(xlmData?.data?.rates?.[currency.toUpperCase()]);
  const usdcRate = parseFloat(usdcData?.data?.rates?.[currency.toUpperCase()]);

  if (!isFinite(xlmRate)  || xlmRate  <= 0) throw new Error(`Coinbase: no valid XLM rate for "${currency}"`);
  if (!isFinite(usdcRate) || usdcRate <= 0) throw new Error(`Coinbase: no valid USDC rate for "${currency}"`);

  return { XLM: xlmRate, USDC: usdcRate };
}

// ── Shared cache helpers (Redis + local fallback) ─────────────────────────────

const _REDIS_KEY = (c) => `currency:rates:${c}`;

async function _readCache(key) {
  if (isRedisReady()) {
    try {
      const raw = await getRedisClient().get(_REDIS_KEY(key));
      if (raw) return JSON.parse(raw);
    } catch (e) {
      logger.warn("Redis cache read failed, falling back to local", { error: e.message });
    }
  }
  return _localCache.get(key) || null;
}

async function _writeCache(key, entry) {
  if (isRedisReady()) {
    try {
      await getRedisClient().set(_REDIS_KEY(key), JSON.stringify(entry), "EX", REDIS_CACHE_TTL_S);
    } catch (e) {
      logger.warn("Redis cache write failed, storing locally", { error: e.message });
    }
  }
  _localCache.set(key, entry);
}

// ── Core fetch with provider failover ────────────────────────────────────────

async function _fetchRates(currency) {
  // Try CoinGecko first, fall back to Coinbase.
  const providers = [
    { name: "coingecko",  fetch: () => _fetchFromCoinGecko(currency)  },
    { name: "coinbase",   fetch: () => _fetchFromCoinbase(currency)   },
  ];

  for (const { name, fetch } of providers) {
    try {
      const rates = await fetch();
      const now = Date.now();
      _recordAvailable(name, true);
      _recordStaleness(name, now);
      logger.info("Price feed fetch succeeded", { provider: name, currency });
      return { rates, fetchedAt: now, lastSuccessfulFetch: now, provider: name };
    } catch (err) {
      _recordAvailable(name, false);
      logger.warn("Price feed provider failed", { provider: name, currency, error: err.message });
    }
  }

  throw new Error(`All price feed providers failed for currency "${currency}"`);
}

// ── getRates (cache + dedup + stale-while-revalidate) ────────────────────────

async function getRates(currency) {
  const key = currency.toUpperCase();

  // Return from cache if fresh.
  const cached = await _readCache(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  // Deduplicate concurrent requests.
  if (_inFlight.has(key)) {
    try { return await _inFlight.get(key); }
    catch { _inFlight.delete(key); }
  }

  const fetchPromise = (async () => {
    try {
      const entry = await _fetchRates(key.toLowerCase());
      await _writeCache(key, entry);
      _inFlight.delete(key);
      return entry;
    } catch (err) {
      _inFlight.delete(key);
      // Stale-while-revalidate: return stale data within threshold.
      if (cached) {
        const staleAge = Math.floor((Date.now() - cached.lastSuccessfulFetch) / 1000);
        if (Date.now() - cached.lastSuccessfulFetch < PRICE_STALE_THRESHOLD_MS) {
          logger.warn("Serving stale rate", { currency: key, staleAge, provider: cached.provider });
          return { ...cached, stale: true, staleAge };
        }
      }
      throw err;
    }
  })();

  _inFlight.set(key, fetchPromise);
  try { return await fetchPromise; }
  catch { return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────

async function convertToLocalCurrency(amount, assetCode = "XLM", targetCurrency = "USD") {
  const currency  = targetCurrency.toUpperCase();
  const rateEntry = await getRates(currency);

  if (!rateEntry) {
    return { localAmount: null, currency, rate: null, rateTimestamp: null, available: false, stale: false, staleAge: null };
  }

  const assetKey = assetCode === "USDC" ? "USDC" : "XLM";
  const rate = rateEntry.rates[assetKey];

  if (typeof rate !== "number" || rate <= 0) {
    return { localAmount: null, currency, rate: null, rateTimestamp: new Date(rateEntry.fetchedAt).toISOString(), available: false, stale: rateEntry.stale || false, staleAge: rateEntry.staleAge || null };
  }

  return {
    localAmount:   _decimalMultiply(amount, rate, currency),
    currency,
    rate,
    rateTimestamp: new Date(rateEntry.fetchedAt).toISOString(),
    available:     true,
    stale:         rateEntry.stale || false,
    staleAge:      rateEntry.staleAge || null,
  };
}

async function enrichPaymentWithConversion(payment, targetCurrency = "USD") {
  const assetCode  = payment.assetCode || "XLM";
  const conversion = await convertToLocalCurrency(payment.amount, assetCode, targetCurrency);

  const txHash     = payment.transactionHash || payment.txHash || null;
  const network    = process.env.STELLAR_NETWORK === "mainnet" ? "public" : "testnet";
  const explorerUrl = txHash ? `https://stellar.expert/explorer/${network}/tx/${txHash}` : null;

  return {
    ...payment,
    stellarExplorerUrl: explorerUrl,
    explorerUrl,
    localCurrency: {
      amount:       conversion.localAmount,
      currency:     conversion.currency,
      rate:         conversion.rate,
      rateTimestamp: conversion.rateTimestamp,
      available:    conversion.available,
    },
  };
}

async function formatWithLocalEquivalent(amount, assetCode = "XLM", targetCurrency = "USD") {
  const base = `${parseFloat(amount).toFixed(7)} ${assetCode}`;
  const conv = await convertToLocalCurrency(amount, assetCode, targetCurrency);
  if (!conv.available || conv.localAmount === null) return `${base} (rate unavailable)`;
  const dp = CURRENCY_DECIMALS[conv.currency.toUpperCase()] ?? 2;
  return `${base} (≈ ${conv.localAmount.toFixed(dp)} ${conv.currency})`;
}

function getCachedRates() {
  const result = {};
  for (const [k, v] of _localCache) {
    result[k] = { rates: { ...v.rates }, fetchedAt: new Date(v.fetchedAt) };
  }
  return result;
}

function resetCache() {
  _localCache.clear();
}

// Back-compat aliases
const fetchXlmRate       = (c = "usd") => getRates(c.toUpperCase()).then((e) => e?.rates?.XLM ?? null);
const convertXlmToLocal  = (a, c = "USD") => convertToLocalCurrency(a, "XLM", c);
const formatWithConversion = (a, c = "USD") => formatWithLocalEquivalent(a, "XLM", c);
const attachConversion   = (o, c = "USD") => enrichPaymentWithConversion(o, c);

/**
 * #883 — Capture a fiat snapshot at payment confirmation time.
 * Returns a plain object suitable for embedding in the payment document.
 * Never throws — returns null if the rate is unavailable so the payment
 * save is never blocked by a price-feed failure.
 *
 * @param {number} amount      - Crypto amount (XLM or USDC)
 * @param {string} assetCode   - 'XLM' | 'USDC'
 * @param {string} currency    - Target fiat currency code, e.g. 'USD'
 */
async function captureFiatSnapshot(amount, assetCode = "XLM", currency = "USD") {
  try {
    const result = await convertToLocalCurrency(amount, assetCode, currency);
    if (!result || !result.available || result.localAmount === null) return null;
    return {
      fiatAmount:    result.localAmount,
      fiatCurrency:  result.currency,
      fiatRate:      result.rate,
      rateSource:    null,       // provider name not exposed here; ok for snapshot
      rateTimestamp: result.rateTimestamp ? new Date(result.rateTimestamp) : new Date(),
    };
  } catch {
    return null;
  }
}

// ── CoinGecko response contract canary (#893) ─────────────────────────────────
//
// Validates that a CoinGecko /simple/price response for the given currency
// still conforms to the expected shape.  Returns { ok: true } when valid or
// { ok: false, reason: string } when the shape has changed.
//
// Intended use:
//   1. In periodic health checks / cron jobs to detect silent API drift.
//   2. In contract tests against a recorded fixture to prevent regressions.
//
// Expected shape (documented contract):
//   data.stellar[lc_currency]     — positive finite number  (XLM rate)
//   data['usd-coin'][lc_currency] — positive finite number  (USDC rate)
function checkCoinGeckoResponseShape(data, currency) {
  const lc = (currency || "").toLowerCase();

  if (!data || typeof data !== "object") {
    return { ok: false, reason: "response is not an object" };
  }
  if (!data.stellar || typeof data.stellar !== "object") {
    return { ok: false, reason: 'missing top-level key "stellar"' };
  }
  if (!data["usd-coin"] || typeof data["usd-coin"] !== "object") {
    return { ok: false, reason: 'missing top-level key "usd-coin"' };
  }

  const xlmRate  = data.stellar[lc];
  const usdcRate = data["usd-coin"][lc];

  if (typeof xlmRate !== "number" || !isFinite(xlmRate) || xlmRate <= 0) {
    return { ok: false, reason: `stellar.${lc} is not a positive finite number (got ${JSON.stringify(xlmRate)})` };
  }
  if (typeof usdcRate !== "number" || !isFinite(usdcRate) || usdcRate <= 0) {
    return { ok: false, reason: `usd-coin.${lc} is not a positive finite number (got ${JSON.stringify(usdcRate)})` };
  }

  return { ok: true };
}

/**
 * Periodic canary: fetches a live CoinGecko rate for `currency` (default
 * "usd") and validates the response shape.  Logs a warning when the shape
 * has drifted so operators are alerted before conversions silently fail.
 *
 * Never throws — designed to be called from a health check or cron without
 * disrupting the main application flow.
 *
 * @param {string} [currency="usd"]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function runCoinGeckoCanary(currency = "usd") {
  try {
    let url =
      "https://api.coingecko.com/api/v3/simple/price" +
      `?ids=stellar%2Cusd-coin&vs_currencies=${encodeURIComponent(currency)}`;
    if (COINGECKO_API_KEY) url += `&x_cg_pro_api_key=${encodeURIComponent(COINGECKO_API_KEY)}`;

    const data   = await httpsGet(url);
    const result = checkCoinGeckoResponseShape(data, currency);

    if (!result.ok) {
      _recordAvailable("coingecko", false);
      logger.warn("CoinGecko canary: response shape mismatch", { currency, reason: result.reason });
    } else {
      logger.info("CoinGecko canary: response shape OK", { currency });
    }

    return result;
  } catch (err) {
    logger.warn("CoinGecko canary: fetch failed", { currency, error: err.message });
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  convertToLocalCurrency,
  enrichPaymentWithConversion,
  formatWithLocalEquivalent,
  captureFiatSnapshot,
  getCachedRates,
  resetCache,
  fetchXlmRate,
  convertXlmToLocal,
  formatWithConversion,
  attachConversion,
  // #893 — CoinGecko contract validation
  checkCoinGeckoResponseShape,
  runCoinGeckoCanary,
  CURRENCY_DECIMALS,
  // Testing internals
  _fetchRatesFromCoinGecko: (c) => _fetchFromCoinGecko(c),
  _getRates: getRates,
  _getCache: getCachedRates,
};
