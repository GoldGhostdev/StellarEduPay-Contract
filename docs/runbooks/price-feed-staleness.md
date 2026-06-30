# Runbook: Price Feed Staleness

**Alert names:** `PriceFeedStalenessWarning` · `PriceFeedStale` · `PriceFeedNoRecentSuccess`  
**Severity:** warning / critical  
**Component:** `currencyConversionService` — CoinGecko / Coinbase Exchange price feeds  
**Closes:** [#891](https://github.com/manuelusman73-png/StellarEduPay/issues/891)

---

## Overview

StellarEduPay fetches live XLM and USDC → fiat exchange rates from CoinGecko (primary) and Coinbase Exchange (fallback). The service caches results and uses a stale-while-revalidate window (`PRICE_STALE_THRESHOLD_MS`, default 1 hour) so that a brief outage does not immediately degrade fiat display.

When both providers are unreachable for an extended period the cache eventually expires and all fiat currency conversions return `"rate unavailable"` to users. This runbook describes how to detect, diagnose, and resolve that condition.

---

## Alert Conditions

| Alert | Condition | Severity |
|---|---|---|
| `PriceFeedStalenessWarning` | `price_feed_staleness_seconds > 300` for 2 min | warning |
| `PriceFeedStale` | `price_feed_stale == 1` for 15 min | critical |
| `PriceFeedNoRecentSuccess` | `time() - price_feed_last_success_timestamp > 600` for 5 min | warning |

A **warning** means the cache is still serving stale-but-valid rates; user-facing impact is minimal. A **critical** means the stale window has expired and fiat amounts now show `"rate unavailable"`.

---

## Metrics Reference

| Metric | Type | Labels | Description |
|---|---|---|---|
| `price_feed_available` | Gauge | `provider` | 1 = provider responded successfully on last attempt |
| `price_feed_staleness_seconds` | Gauge | `provider` | Seconds since the last successful fetch |
| `price_feed_last_success_timestamp` | Gauge | `provider` | Unix timestamp (seconds) of the most recent successful fetch |
| `price_feed_stale` | Gauge | `provider` | 1 when the stale-while-revalidate window is exhausted |

Useful PromQL:

```promql
# How old is the most recent successful fetch (in minutes)?
(time() - price_feed_last_success_timestamp) / 60

# Which providers are currently down?
price_feed_available == 0

# Is the stale flag set?
price_feed_stale == 1
```

---

## Step-by-Step Response

### 1. Confirm the alert

Open Prometheus (`http://localhost:9090`) and run:

```promql
price_feed_stale
price_feed_staleness_seconds
price_feed_last_success_timestamp
```

Check whether one or both providers are affected. If only CoinGecko is affected, the Coinbase fallback should be returning data — this points to a CoinGecko-specific outage.

### 2. Check backend logs

```bash
# Docker Compose
docker compose logs --tail=200 backend | grep -i "price feed\|coingecko\|coinbase\|CurrencyConversion"

# Or with the JSON log filter
docker compose logs --tail=200 backend | jq 'select(.msg | test("price feed|coingecko|coinbase"; "i"))'
```

Look for:
- `"Price feed provider failed"` — repeated failures confirm the outage.
- `"Serving stale rate"` — the stale-while-revalidate window is active.
- HTTP error codes (429, 503, timeout) indicate the nature of the failure.

### 3. Test providers directly

Test CoinGecko from the host or a container:

```bash
curl -s "https://api.coingecko.com/api/v3/simple/price?ids=stellar%2Cusd-coin&vs_currencies=usd" | jq .
```

Test Coinbase:

```bash
curl -s "https://api.coinbase.com/v2/exchange-rates?currency=XLM" | jq .data.rates.USD
curl -s "https://api.coinbase.com/v2/exchange-rates?currency=USDC" | jq .data.rates.USD
```

- **HTTP 200 with valid data** → the provider is reachable; investigate network or auth issues within the backend container.
- **HTTP 429** → rate-limited. If you have a `COINGECKO_API_KEY` set, verify it is correct and the plan quota is not exhausted.
- **Connection refused / timeout** → network-level or DNS failure. Check outbound connectivity from the backend container.

### 4. Check external status pages

- CoinGecko: https://status.coingecko.com/
- Coinbase: https://status.coinbase.com/

If a provider is reporting an incident, the issue is upstream. Record the incident URL in the incident channel and move to [Mitigation](#5-mitigation) while waiting for recovery.

### 5. Mitigation

**Option A — Wait for provider recovery** (recommended for a short outage < 1 hour)  
The stale-while-revalidate cache will serve existing rates until `PRICE_STALE_THRESHOLD_MS` (default 1 hour). No action is required while the window is active (`PriceFeedStalenessWarning` only). Monitor `price_feed_staleness_seconds` and escalate to Option B if it approaches the threshold.

**Option B — Extend the stale window temporarily**  
If the outage is expected to last longer than 1 hour:

```bash
# Extend stale threshold to 6 hours without restarting (requires env var + restart)
# In backend/.env:
PRICE_STALE_THRESHOLD_MS=21600000
# Then restart the backend:
docker compose restart backend
```

This keeps fiat display working at the cost of showing older rates. Communicate to users that rates may be up to N hours old.

**Option C — CoinGecko API key rotation**  
If the failure is a 401/403 due to an expired or revoked API key:

1. Generate a new key at https://www.coingecko.com/en/api
2. Update `COINGECKO_API_KEY` in `backend/.env`
3. Restart the backend: `docker compose restart backend`

**Option D — Force cache invalidation**  
If the provider is back up but the in-process cache is stale:

```bash
# The cache is in-process (or Redis). Restarting the backend clears it:
docker compose restart backend
```

Alternatively, if Redis is the cache backend, flush the currency keys:

```bash
redis-cli --scan --pattern "currency:rates:*" | xargs redis-cli del
```

### 6. Verify recovery

After the provider recovers or the cache is refreshed, confirm:

```promql
# Staleness should drop back to near-zero
price_feed_staleness_seconds

# Available should be 1 again
price_feed_available

# Stale flag should clear
price_feed_stale

# Timestamp should advance
price_feed_last_success_timestamp
```

Check backend logs for `"Price feed fetch succeeded"`.

Test the API endpoint:

```bash
curl -s http://localhost:5000/api/payments/instructions/<any-student-id> | jq .localCurrency
```

The `available` field should be `true` and `amount` should be a number.

### 7. Post-incident

1. Note the duration and root cause in the incident log.
2. If the outage was > 30 minutes, consider whether `PRICE_STALE_THRESHOLD_MS` should be increased permanently.
3. If CoinGecko was the sole cause, verify the Coinbase fallback was activating (check logs for `"provider": "coinbase"` success entries) — if it was not, the fallback itself may have a bug.
4. Update this runbook with any new findings.

---

## Related Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PRICE_CACHE_TTL_MS` | `60000` (1 min) | How long a fresh fetch is considered valid before re-fetching |
| `PRICE_STALE_THRESHOLD_MS` | `3600000` (1 hour) | Maximum age of stale cache that will still be served |
| `COINGECKO_API_KEY` | — | Optional Pro API key; without it the free tier applies (rate-limited) |

## Related Documents

- [Architecture overview](../architecture.md)
- [Monitoring & Observability — README](../../README.md#monitoring--observability)
- [Recommended Alerting Thresholds](../../README.md#recommended-alerting-thresholds)
- Prometheus alerts: [`monitoring/alerts/price_feed.yml`](../../monitoring/alerts/price_feed.yml)
- Service implementation: [`backend/src/services/currencyConversionService.js`](../../backend/src/services/currencyConversionService.js)
