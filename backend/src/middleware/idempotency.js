'use strict';

const { deriveIdempotencyKey } = require('../utils/idempotencyKey');
const idempotencyStore = require('../services/idempotencyStore');

/**
 * Idempotency middleware.
 *
 * Expects an `Idempotency-Key` header on mutating requests.
 * - If the key has been seen before and the response is cached, returns it immediately.
 * - If the key is new, processes the request normally and caches the response.
 * - If the header is missing, rejects with 400.
 *
 * The canonical key is derived via the shared `deriveIdempotencyKey` util
 * (scoped by request path) and stored in the persistent `idempotencyStore`, so
 * a replay is recognized after a restart or on another replica — and the
 * derivation never diverges from the payment processor's.
 *
 * Usage: apply to individual POST routes that must be idempotent.
 */
function idempotency(req, res, next) {
  const rawKey = req.headers['idempotency-key'];

  if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
    return res.status(400).json({
      error: 'Idempotency-Key header is required for this request',
      code: 'MISSING_IDEMPOTENCY_KEY',
    });
  }

  const scope = req.path;
  const canonicalKey = deriveIdempotencyKey(rawKey, scope);

  // Check for a cached response
  idempotencyStore
    .get(canonicalKey)
    .then((record) => {
      if (record) {
        // Replay the cached response — same status, same body
        return res.status(record.responseStatus).json(record.responseBody);
      }

      // Intercept res.json to capture and cache the response before sending
      const originalJson = res.json.bind(res);

      res.json = function (body) {
        // Only cache successful or expected error responses (not 5xx)
        if (res.statusCode < 500) {
          idempotencyStore
            .set(canonicalKey, {
              scope,
              responseStatus: res.statusCode,
              responseBody: body,
            })
            .catch((err) => {
              console.error('[Idempotency] Failed to cache response:', err.message);
            });
        }
        return originalJson(body);
      };

      next();
    })
    .catch((err) => {
      console.error('[Idempotency] store lookup failed:', err.message);
      // Fail open — let the request through rather than blocking the user
      next();
    });
}

module.exports = idempotency;
