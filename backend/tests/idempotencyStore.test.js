'use strict';

/**
 * Tests for the persistent idempotency store.
 *
 * The Mongo model is mocked with a Map that lives in the TEST process (not the
 * module under test), so we can re-require `idempotencyStore` with fresh module
 * state to simulate a process restart / second replica while the durable
 * backing survives. Redis is disabled (REDIS_HOST unset), exercising the
 * Mongo-only source-of-truth path.
 */

// Durable backing store, shared across module reloads. `mock` prefix lets the
// hoisted jest.mock factory reference it.
const mockDb = new Map();

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

jest.mock('../src/models/idempotencyKeyModel', () => {
  const model = {
    findOne: ({ key }) => ({
      lean: async () => mockDb.get(key) || null,
    }),
    create: async (doc) => {
      if (mockDb.has(doc.key)) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      mockDb.set(doc.key, doc);
      return doc;
    },
  };
  model.TTL_SECONDS = 86400;
  return model;
});

beforeEach(() => {
  mockDb.clear();
  delete process.env.REDIS_HOST;
  jest.resetModules();
});

describe('idempotencyStore', () => {
  it('returns null for an unknown key', async () => {
    const store = require('../src/services/idempotencyStore');
    expect(await store.get('missing')).toBeNull();
  });

  it('persists and reads back a record', async () => {
    const store = require('../src/services/idempotencyStore');
    await store.set('k1', { scope: 's', responseStatus: 200, responseBody: { ok: true } });

    const rec = await store.get('k1');
    expect(rec).toEqual({ scope: 's', responseStatus: 200, responseBody: { ok: true } });
  });

  it('recognizes a replay after a process restart (fresh module state)', async () => {
    // Replica A writes the result.
    const storeA = require('../src/services/idempotencyStore');
    await storeA.set('order-1', {
      scope: 'payment-processor',
      responseStatus: 200,
      responseBody: { success: true, data: { paymentId: 'p1' } },
    });

    // Simulate a restart / second replica: brand-new module instance, no
    // in-process state — only the durable Mongo backing remains.
    jest.resetModules();
    const storeB = require('../src/services/idempotencyStore');

    const rec = await storeB.get('order-1');
    expect(rec).not.toBeNull();
    expect(rec.responseBody).toEqual({ success: true, data: { paymentId: 'p1' } });
  });

  it('treats a duplicate-key write race as success', async () => {
    const store = require('../src/services/idempotencyStore');
    const record = { scope: 's', responseStatus: 200, responseBody: { ok: 1 } };
    await store.set('dup', record);
    // Second writer loses the race; must not throw.
    await expect(store.set('dup', record)).resolves.toBeUndefined();
  });

  it('does nothing for a null key', async () => {
    const store = require('../src/services/idempotencyStore');
    expect(await store.get(null)).toBeNull();
    await expect(store.set(null, { responseStatus: 200, responseBody: {} })).resolves.toBeUndefined();
    expect(mockDb.size).toBe(0);
  });
});
