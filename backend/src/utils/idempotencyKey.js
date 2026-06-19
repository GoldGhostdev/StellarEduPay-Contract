'use strict';

/**
 * Canonical idempotency-key derivation.
 *
 * This is the SINGLE source of truth for turning a client-supplied
 * `Idempotency-Key` (HTTP header) into the canonical key under which a
 * request's result is stored and looked up. Both the idempotency middleware
 * and the concurrent payment processor MUST derive keys through this module so
 * that the same logical request maps to the same canonical key — otherwise the
 * two layers can disagree about whether a request is a duplicate.
 *
 * Derivation rules:
 *   - The raw client key is normalized: coerced to string, trimmed. An empty
 *     or missing key yields `null` (no idempotency).
 *   - A `scope` namespaces the key so that the same client key used on
 *     different operations (e.g. a route path vs. the payment processor) does
 *     not collide. The scope is itself trimmed/normalized.
 *   - The canonical key is `sha256(scope "\n" clientKey)` hex-encoded. Hashing
 *     gives a fixed-length, index-friendly key and avoids leaking raw client
 *     values into logs/storage keys.
 */

const crypto = require('crypto');

/**
 * Normalize a raw client-supplied idempotency key.
 * @param {*} rawKey
 * @returns {string|null} trimmed string, or null when absent/empty.
 */
function normalizeClientKey(rawKey) {
  if (rawKey === null || rawKey === undefined) return null;
  const str = String(rawKey).trim();
  return str.length > 0 ? str : null;
}

/**
 * Derive the canonical idempotency key for a (clientKey, scope) pair.
 * @param {*} rawKey raw client-supplied key (e.g. the Idempotency-Key header)
 * @param {string} [scope] namespace for the operation (e.g. request path)
 * @returns {string|null} canonical hex key, or null when no usable client key.
 */
function deriveIdempotencyKey(rawKey, scope = '') {
  const clientKey = normalizeClientKey(rawKey);
  if (!clientKey) return null;

  const normalizedScope = scope === null || scope === undefined ? '' : String(scope).trim();

  return crypto
    .createHash('sha256')
    .update(`${normalizedScope}\n${clientKey}`)
    .digest('hex');
}

module.exports = {
  normalizeClientKey,
  deriveIdempotencyKey,
};
