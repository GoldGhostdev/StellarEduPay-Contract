'use strict';

/**
 * Unit tests for the canonical idempotency-key derivation — the single
 * function shared by the idempotency middleware and the payment processor.
 * These guarantee both layers interpret a client key identically (no
 * divergence) and that scoping prevents cross-operation collisions.
 */

const crypto = require('crypto');
const {
  deriveIdempotencyKey,
  normalizeClientKey,
} = require('../src/utils/idempotencyKey');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('normalizeClientKey', () => {
  it('returns null for missing keys', () => {
    expect(normalizeClientKey(undefined)).toBeNull();
    expect(normalizeClientKey(null)).toBeNull();
  });

  it('returns null for empty / whitespace-only keys', () => {
    expect(normalizeClientKey('')).toBeNull();
    expect(normalizeClientKey('   ')).toBeNull();
    expect(normalizeClientKey('\t\n')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeClientKey('  abc  ')).toBe('abc');
  });

  it('coerces non-strings to string', () => {
    expect(normalizeClientKey(12345)).toBe('12345');
  });
});

describe('deriveIdempotencyKey', () => {
  it('returns null when there is no usable client key', () => {
    expect(deriveIdempotencyKey(undefined, 'scope')).toBeNull();
    expect(deriveIdempotencyKey('', 'scope')).toBeNull();
    expect(deriveIdempotencyKey('   ', 'scope')).toBeNull();
  });

  it('produces a deterministic sha256 hex string', () => {
    const key = deriveIdempotencyKey('order-1', 'payment-processor');
    expect(key).toBe(sha256('payment-processor\norder-1'));
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is stable across calls for the same inputs', () => {
    expect(deriveIdempotencyKey('order-1', 's')).toBe(
      deriveIdempotencyKey('order-1', 's')
    );
  });

  it('normalizes the client key before hashing (whitespace-insensitive)', () => {
    // The core anti-divergence guarantee: a padded key and a clean key map to
    // the same canonical key, so middleware and processor cannot disagree.
    expect(deriveIdempotencyKey('  order-1  ', 's')).toBe(
      deriveIdempotencyKey('order-1', 's')
    );
  });

  it('namespaces by scope so the same client key never collides across operations', () => {
    const inProcessor = deriveIdempotencyKey('order-1', 'payment-processor');
    const inMiddleware = deriveIdempotencyKey('order-1', '/api/payments/process');
    expect(inProcessor).not.toBe(inMiddleware);
  });

  it('treats missing/empty/whitespace scopes identically', () => {
    const expected = deriveIdempotencyKey('order-1', '');
    expect(deriveIdempotencyKey('order-1', undefined)).toBe(expected);
    expect(deriveIdempotencyKey('order-1', null)).toBe(expected);
    expect(deriveIdempotencyKey('order-1', '   ')).toBe(expected);
  });

  it('distinguishes different client keys within the same scope', () => {
    expect(deriveIdempotencyKey('order-1', 's')).not.toBe(
      deriveIdempotencyKey('order-2', 's')
    );
  });
});
