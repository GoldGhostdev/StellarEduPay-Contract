"use strict";

/**
 * currencyConversionService — converts XLM and USDC amounts to local currency equivalents.
 *
 * Design decisions:
 *   - Uses CoinGecko's API (/simple/price) — supports optional API key for Pro tier.
 *   - Per-currency in-memory cache with configurable TTL (default 60 s).
 *   - Request deduplication: concurrent requests for same currency share one HTTP call.
 *   - Supports both XLM and USDC asset codes (the two accepted assets in StellarEduPay).
 *   - Graceful degradation: if the price feed is unavailable, fiat fields are null
 *     and `available: false` is returned — callers display XLM-only without crashing.
 *   - Per-school target currency support (defaults to USD).
 */

const https = require("https");

// ── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = parseInt(process.env.PRICE_CACHE_TTL_MS || "60000", 10);
const PRICE_STALE_THRESHOLD_MS = parseInt(process.env.PRICE_STALE_THRESHOLD_MS || "3600000", 10); // 1 hour default
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || null;

/**
 * Cache structure (keyed by uppercase currency code):
 *   rateCache['USD'] = { rates: { XLM: 0.24, USDC: 1.00 }, fetchedAt: Date, lastSuccessfulFetch: Date }
 */
const rateCache = {};

/**
 * In-flight request deduplication map.
 * Prevents concurrent requests for the same currency from hitting the API multiple times.
 * Structure: inFlightRequests['USD'] = Promise<{ rates, fetchedAt }>
 */
const inFlightRequests = {};

/** Exposed for testing — resets the in-memory cache. */
function resetCache() {
  Object.keys(rateCache).forEach((k) => delete rateCache[k]);
}

/** Return the current cache snapshot (copy) — used by health endpoints. */
function getCachedRates() {
  return Object.fromEntries(
    Object.entries(rateCache).map(([k, v]) => [
      k,
      { rates: { ...v.rates }, fetchedAt: v.fetchedAt },
    ]),
  );
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

/**
 * Minimal promise-based HTTPS GET (uses only Node built-ins).
 * @param {string} url
 * @returns {Promise<object>} Parsed JSON body
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} from price feed`));
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Invalid JSON from price feed"));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Price feed request timed out"));
    });
    req.on("error", reject);
  });
}

// ── Price feed ───────────────────────────────────────────────────────────────

/**
 * Fetch rates for both XLM and USDC against targetCurrency from CoinGecko.
 * CoinGecko IDs: stellar = XLM, usd-coin = USDC.
 *
 * Uses Pro API endpoint if COINGECKO_API_KEY is set, otherwise uses free tier.
 *
 * @param {string} currency  Lowercase ISO 4217 code (e.g. "usd", "pgk", "ngn")
 * @returns {Promise<{ XLM: number, USDC: number }>}
 */
async function fetchRatesFromCoinGecko(currency) {
  let url =
    "https://api.coingecko.com/api/v3/simple/price" +
    `?ids=stellar%2Cusd-coin&vs_currencies=${encodeURIComponent(currency)}`;

  // Add API key header if available (Pro tier)
  if (COINGECKO_API_KEY) {
    url += `&x_cg_pro_api_key=${encodeURIComponent(COINGECKO_API_KEY)}`;
  }

  const data = await httpsGet(url);

  const xlmRate = data?.stellar?.[currency];
  const usdcRate = data?.["usd-coin"]?.[currency];

  if (typeof xlmRate !== "number" || xlmRate <= 0) {
    throw new Error(
      `CoinGecko did not return a valid XLM rate for "${currency}". ` +
        `Verify this is a supported vs_currency code.`,
    );
  }
  if (typeof usdcRate !== "number" || usdcRate <= 0) {
    throw new Error(
      `CoinGecko did not return a valid USDC rate for "${currency}".`,
    );
  }

  return { XLM: xlmRate, USDC: usdcRate };
}

/**
 * Return cached rates if fresh, otherwise fetch and cache.
 * Implements stale-while-revalidate: if fetch fails, return stale cache with stale flag.
 * Implements request deduplication: concurrent calls for the same currency
 * share a single in-flight HTTP request.
 *
 * @param {string} currency  Uppercase ISO 4217 code (e.g. "USD", "PGK", "NGN")
 * @returns {Promise<{ rates: { XLM: number, USDC: number }, fetchedAt: Date, stale?: boolean, staleAge?: number } | null>}
 */
async function getRates(currency) {
  const key = currency.toUpperCase();
  const cached = rateCache[key];

  // Return fresh cache if available
  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return cached;
  }

  // Request deduplication: if a request is already in-flight, wait for it
  if (inFlightRequests[key]) {
    try {
      return await inFlightRequests[key];
    } catch (err) {
      // If in-flight request failed, fall through to retry
      delete inFlightRequests[key];
    }
  }

  // Create new in-flight request
  const fetchPromise = (async () => {
    try {
      const rates = await fetchRatesFromCoinGecko(key.toLowerCase());
      const now = new Date();
      const entry = { rates, fetchedAt: now, lastSuccessfulFetch: now };
      rateCache[key] = entry;
      delete inFlightRequests[key];
      return entry;
    } catch (err) {
      delete inFlightRequests[key];
      console.warn("[CurrencyConversion] Price feed unavailable:", err.message);
      
      // Stale-while-revalidate: return stale cache if within threshold
      if (cached) {
        const staleAge = Math.floor((Date.now() - cached.lastSuccessfulFetch.getTime()) / 1000);
        if (staleAge < PRICE_STALE_THRESHOLD_MS / 1000) {
          console.warn(
            "[CurrencyConversion] Serving stale rate from",
            cached.lastSuccessfulFetch.toISOString(),
            `(${staleAge}s old)`,
          );
          return { ...cached, stale: true, staleAge };
        }
      }
      throw err;
    }
  })();

  inFlightRequests[key] = fetchPromise;

  try {
    return await fetchPromise;
  } catch (err) {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert an asset amount (XLM or USDC) to its local currency equivalent.
 *
 * @param {number} amount         Amount in asset units
 * @param {string} assetCode      "XLM" or "USDC"
 * @param {string} targetCurrency ISO 4217 currency code, e.g. "USD", "PGK", "NGN"
 *
 * @returns {Promise<{
 *   localAmount:    number | null,   // rounded to 2 decimal places; null if unavailable
 *   currency:       string,          // e.g. "USD"
 *   rate:           number | null,   // exchange rate used (assetCode → currency)
 *   rateTimestamp:  string | null,   // ISO string of when rate was fetched
 *   available:      boolean,         // false when price feed was unavailable
 *   stale:          boolean,         // true if rate is older than CACHE_TTL_MS but within PRICE_STALE_THRESHOLD_MS
 *   staleAge:       number | null,   // seconds since last successful fetch (only if stale: true)
 * }>}
 */
async function convertToLocalCurrency(
  amount,
  assetCode = "XLM",
  targetCurrency = "USD",
) {
  const currency = targetCurrency.toUpperCase();
  const rateEntry = await getRates(currency);

  if (!rateEntry) {
    return {
      localAmount: null,
      currency,
      rate: null,
      rateTimestamp: null,
      available: false,
      stale: false,
      staleAge: null,
    };
  }

  // Normalise: treat unknown assets like XLM for display purposes
  const assetKey = assetCode === "USDC" ? "USDC" : "XLM";
  const rate = rateEntry.rates[assetKey];

  if (typeof rate !== "number" || rate <= 0) {
    return {
      localAmount: null,
      currency,
      rate: null,
      rateTimestamp: rateEntry.fetchedAt.toISOString(),
      available: false,
      stale: rateEntry.stale || false,
      staleAge: rateEntry.staleAge || null,
    };
  }

  return {
    localAmount: parseFloat((amount * rate).toFixed(2)),
    currency,
    rate,
    rateTimestamp: rateEntry.fetchedAt.toISOString(),
    available: true,
    stale: rateEntry.stale || false,
    staleAge: rateEntry.staleAge || null,
  };
}

/**
 * Attach a `localCurrency` field to a payment object (non-mutating).
 * Used by controllers to enrich responses without repeating conversion logic.
 *
 * @param {object} payment        Must have `amount` and optionally `assetCode`
 * @param {string} targetCurrency School's preferred currency
 * @returns {Promise<object>}
 */
async function enrichPaymentWithConversion(payment, targetCurrency = "USD") {
  const assetCode = payment.assetCode || "XLM";
  const conversion = await convertToLocalCurrency(
    payment.amount,
    assetCode,
    targetCurrency,
  );

  const txHash = payment.transactionHash || payment.txHash || null;
  const network =
    process.env.STELLAR_NETWORK === "mainnet" ? "public" : "testnet";
  const explorerUrl = txHash
    ? `https://stellar.expert/explorer/${network}/tx/${txHash}`
    : null;

  return {
    ...payment,
    stellarExplorerUrl: explorerUrl,
    explorerUrl,
    localCurrency: {
      amount: conversion.localAmount,
      currency: conversion.currency,
      rate: conversion.rate,
      rateTimestamp: conversion.rateTimestamp,
      available: conversion.available,
    },
  };
}

/**
 * Build a human-readable dual-currency display string.
 *
 * Examples:
 *   "10.0000000 XLM (≈ 2.40 USD)"
 *   "50.0000000 USDC (≈ 50.00 USD)"
 *   "10.0000000 XLM (rate unavailable)"
 *
 * @param {number} amount
 * @param {string} assetCode
 * @param {string} targetCurrency
 * @returns {Promise<string>}
 */
async function formatWithLocalEquivalent(
  amount,
  assetCode = "XLM",
  targetCurrency = "USD",
) {
  const base = `${parseFloat(amount).toFixed(7)} ${assetCode}`;
  const conv = await convertToLocalCurrency(amount, assetCode, targetCurrency);

  if (!conv.available || conv.localAmount === null) {
    return `${base} (rate unavailable)`;
  }
  return `${base} (≈ ${conv.localAmount.toFixed(2)} ${conv.currency})`;
}

// Back-compat alias (kept for existing call sites that used the old XLM-only service)
const fetchXlmRate = (currency = "usd") =>
  getRates(currency.toUpperCase()).then((e) => e?.rates?.XLM ?? null);
const convertXlmToLocal = (xlmAmount, targetCurrency = "USD") =>
  convertToLocalCurrency(xlmAmount, "XLM", targetCurrency);
const formatWithConversion = (xlmAmount, targetCurrency = "USD") =>
  formatWithLocalEquivalent(xlmAmount, "XLM", targetCurrency);
const attachConversion = (obj, targetCurrency = "USD") =>
  enrichPaymentWithConversion(obj, targetCurrency);

module.exports = {
  // Primary API
  convertToLocalCurrency,
  enrichPaymentWithConversion,
  formatWithLocalEquivalent,
  getCachedRates,
  resetCache,

  // Back-compat aliases (XLM-only callers)
  fetchXlmRate,
  convertXlmToLocal,
  formatWithConversion,
  attachConversion,

  // Testing internals
  _fetchRatesFromCoinGecko: fetchRatesFromCoinGecko,
  _getRates: getRates,
  _getCache: () => ({ ...rateCache }),
};
