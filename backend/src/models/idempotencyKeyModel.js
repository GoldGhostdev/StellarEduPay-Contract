'use strict';

const mongoose = require('mongoose');

// TTL in seconds for idempotency key records.
// Configurable via IDEMPOTENCY_KEY_TTL_SECONDS (default: 86400 = 24 hours).
// MongoDB's TTL index will automatically delete documents after this period.
const TTL_SECONDS = parseInt(process.env.IDEMPOTENCY_KEY_TTL_SECONDS || '86400', 10);

/**
 * Persistent idempotency store — the single source of truth for whether a
 * logical request has already been processed. Keyed by the canonical key
 * produced by `utils/idempotencyKey.deriveIdempotencyKey`, which already folds
 * the operation scope into the hash, so the canonical `key` alone is unique.
 *
 * Records survive process restarts and are shared across replicas, so a request
 * replayed after a deploy (or hitting a second replica) is still recognized as
 * a duplicate.
 *
 * TTL index automatically purges records after IDEMPOTENCY_KEY_TTL_SECONDS.
 */
const idempotencyKeySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  // Informational namespace for the canonical key (e.g. a request path or
  // 'payment-processor'). The scope is already baked into `key`; this is kept
  // for debuggability and is not part of the lookup.
  scope: { type: String, default: '' },
  responseStatus: { type: Number, required: true },
  responseBody: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, expires: TTL_SECONDS },
});

module.exports = mongoose.model('IdempotencyKey', idempotencyKeySchema);
module.exports.TTL_SECONDS = TTL_SECONDS;
