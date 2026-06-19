'use strict';

/**
 * Persistent idempotency store — the single source of truth for idempotency
 * decisions across the app.
 *
 * Backing: MongoDB (`idempotencyKeyModel`) is authoritative and durable, so a
 * replayed request is recognized as a duplicate even after a process restart or
 * on a different replica. An OPTIONAL Redis layer sits in front as a
 * read-through cache to avoid a Mongo round-trip on the hot path; it is never
 * the source of truth. When REDIS_HOST is unset, the store degrades to
 * Mongo-only, which is fully correct (just one extra query per lookup).
 *
 * All keys passed in must already be the canonical key produced by
 * `utils/idempotencyKey.deriveIdempotencyKey`.
 */

const IdempotencyKey = require('../models/idempotencyKeyModel');
const logger = require('../utils/logger').child('IdempotencyStore');

const TTL_SECONDS = IdempotencyKey.TTL_SECONDS;
const REDIS_PREFIX = 'idem:';

const redisEnabled = Boolean(process.env.REDIS_HOST);

let redis = null;
if (redisEnabled) {
  const Redis = require('ioredis');
  redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  redis.on('error', (err) => logger.error('Redis idempotency client error', { error: err.message }));
  redis.connect().catch((err) =>
    logger.error('Redis idempotency client connect failed', { error: err.message })
  );
}

async function redisGet(key) {
  if (!redis) return null;
  try {
    const raw = await redis.get(REDIS_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('Redis idempotency read failed, falling back to Mongo', { error: err.message });
    return null;
  }
}

async function redisSet(key, record) {
  if (!redis) return;
  try {
    await redis.set(REDIS_PREFIX + key, JSON.stringify(record), 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn('Redis idempotency write failed (non-fatal)', { error: err.message });
  }
}

/**
 * Look up a previously stored idempotency record by canonical key.
 * Checks Redis first (if enabled), then Mongo; populates Redis on a Mongo hit.
 *
 * @param {string} key canonical idempotency key
 * @returns {Promise<{responseStatus:number, responseBody:*, scope:string}|null>}
 */
async function get(key) {
  if (!key) return null;

  const cached = await redisGet(key);
  if (cached) return cached;

  const record = await IdempotencyKey.findOne({ key }).lean();
  if (!record) return null;

  const result = {
    responseStatus: record.responseStatus,
    responseBody: record.responseBody,
    scope: record.scope || '',
  };

  // Read-through: warm Redis for subsequent lookups.
  await redisSet(key, result);
  return result;
}

/**
 * Persist an idempotency record. Mongo is written first (source of truth),
 * then Redis is warmed. A duplicate-key race (another request won) is treated
 * as success — the stored result is equivalent.
 *
 * @param {string} key canonical idempotency key
 * @param {{responseStatus:number, responseBody:*, scope?:string}} record
 * @returns {Promise<void>}
 */
async function set(key, record) {
  if (!key) return;

  const doc = {
    responseStatus: record.responseStatus,
    responseBody: record.responseBody,
    scope: record.scope || '',
  };

  try {
    await IdempotencyKey.create({ key, ...doc });
  } catch (err) {
    if (err.code !== 11000) {
      logger.error('Failed to persist idempotency record', { error: err.message });
      throw err;
    }
    // Duplicate key — another request already persisted this result. Fine.
  }

  await redisSet(key, doc);
}

module.exports = { get, set, redisEnabled };
