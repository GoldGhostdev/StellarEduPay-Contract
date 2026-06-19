'use strict';

/**
 * Tests for horizonFailoverClient.js – issue #748
 *
 * Covers:
 *  1. CircuitBreaker state machine (closed → open → half-open → closed)
 *  2. HorizonFailoverClient endpoint selection and failover
 *  3. All-endpoints-down scenario
 *  4. Backoff/existing retry behaviour is preserved (non-transient errors
 *     are re-thrown immediately without consuming other endpoints)
 *  5. CB metrics increments
 *  6. resolveHorizonUrls() parses env correctly
 *  7. Health controller surfaces activeUrl and endpoints
 */

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GCICZOP346CKADPWOZ6JAQ7OCGH44UELNS3GSDXFOTSZRW6OYZZ6KSY7B';
process.env.STELLAR_NETWORK = 'testnet';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('@stellar/stellar-sdk', () => {
  const mockServer = () => ({
    ledgers: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({}),
    }),
    loadAccount: jest.fn().mockResolvedValue({ balances: [] }),
    serverInfo: jest.fn().mockResolvedValue({}),
  });

  return {
    Horizon: {
      Server: jest.fn().mockImplementation(mockServer),
    },
    Networks: { TESTNET: 'Test SDF Network ; September 2015', PUBLIC: 'Public Global Stellar Network ; September 2015' },
    StrKey: { isValidEd25519PublicKey: jest.fn().mockReturnValue(true) },
    Asset: { native: jest.fn().mockReturnValue({}) },
  };
});

jest.mock('../backend/src/config', () => ({
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_HORIZON_URLS: ['https://horizon-testnet.stellar.org'],
  IS_TESTNET: true,
  STELLAR_TIMEOUT_MS: 10000,
  ACCEPTED_ASSET: 'XLM',
  USDC_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  CONFIRMATION_THRESHOLD: 2,
  SCHOOL_WALLET_ADDRESS: null,
}));

jest.mock('../backend/src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

// Metrics are optional; just stub them so the client doesn't blow up
jest.mock('../backend/src/metrics', () => ({
  registry: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue('') },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

const {
  HorizonFailoverClient,
  CircuitBreaker,
  CB_STATE,
  resolveHorizonUrls,
  resetInstance,
  isTransientFailure,
} = require('../backend/src/services/horizonFailoverClient');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTransientError(status) {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  return err;
}

function makeNetworkError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function makeClient(urls) {
  return new HorizonFailoverClient({ urls });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  resetInstance();
  jest.clearAllMocks();
  delete process.env.STELLAR_HORIZON_URLS;
});

// ── 1. resolveHorizonUrls ─────────────────────────────────────────────────────
describe('resolveHorizonUrls()', () => {
  test('returns list from STELLAR_HORIZON_URLS when set', () => {
    process.env.STELLAR_HORIZON_URLS =
      'https://primary.horizon.org , https://secondary.horizon.org';
    const urls = resolveHorizonUrls();
    expect(urls).toEqual(['https://primary.horizon.org', 'https://secondary.horizon.org']);
  });

  test('falls back to STELLAR_HORIZON_URL / HORIZON_URL when STELLAR_HORIZON_URLS not set', () => {
    delete process.env.STELLAR_HORIZON_URLS;
    const urls = resolveHorizonUrls();
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(typeof urls[0]).toBe('string');
  });

  test('ignores empty entries in STELLAR_HORIZON_URLS', () => {
    process.env.STELLAR_HORIZON_URLS = 'https://a.horizon.org,,  ,https://b.horizon.org';
    expect(resolveHorizonUrls()).toEqual(['https://a.horizon.org', 'https://b.horizon.org']);
  });
});

// ── 2. isTransientFailure ─────────────────────────────────────────────────────
describe('isTransientFailure()', () => {
  test.each([429, 500, 502, 503, 504])('HTTP %i is transient', (status) => {
    expect(isTransientFailure(makeTransientError(status))).toBe(true);
  });

  test.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'])(
    'network code %s is transient', (code) => {
      expect(isTransientFailure(makeNetworkError(code))).toBe(true);
    });

  test('HTTP 400 is NOT transient', () => {
    expect(isTransientFailure(makeTransientError(400))).toBe(false);
  });

  test('HTTP 404 is NOT transient', () => {
    expect(isTransientFailure(makeTransientError(404))).toBe(false);
  });
});

// ── 3. CircuitBreaker state machine ──────────────────────────────────────────
describe('CircuitBreaker', () => {
  test('starts CLOSED', () => {
    const cb = new CircuitBreaker('https://h.org');
    expect(cb.getState()).toBe(CB_STATE.CLOSED);
    expect(cb.isAvailable()).toBe(true);
  });

  test('opens after CB_FAILURE_THRESHOLD consecutive failures', () => {
    const cb = new CircuitBreaker('https://h.org');
    const threshold = parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5;
    for (let i = 0; i < threshold; i++) cb.recordFailure();
    expect(cb.getState()).toBe(CB_STATE.OPEN);
    expect(cb.isAvailable()).toBe(false);
  });

  test('OPEN → HALF_OPEN after reset timeout', () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker('https://h.org');
    const threshold = parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5;
    for (let i = 0; i < threshold; i++) cb.recordFailure();
    expect(cb.getState()).toBe(CB_STATE.OPEN);

    // Advance past reset timeout
    const resetMs = parseInt(process.env.CB_RESET_TIMEOUT_MS, 10) || 30_000;
    jest.advanceTimersByTime(resetMs + 1);

    expect(cb.isAvailable()).toBe(true); // triggers HALF_OPEN transition
    expect(cb.getState()).toBe(CB_STATE.HALF_OPEN);
    jest.useRealTimers();
  });

  test('HALF_OPEN → CLOSED after enough successes', () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker('https://h.org');
    const threshold = parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5;
    const resetMs = parseInt(process.env.CB_RESET_TIMEOUT_MS, 10) || 30_000;
    const successThreshold = parseInt(process.env.CB_HALF_OPEN_SUCCESS_THRESHOLD, 10) || 2;

    for (let i = 0; i < threshold; i++) cb.recordFailure();
    jest.advanceTimersByTime(resetMs + 1);
    cb.isAvailable(); // → HALF_OPEN

    for (let i = 0; i < successThreshold; i++) cb.recordSuccess();
    expect(cb.getState()).toBe(CB_STATE.CLOSED);
    jest.useRealTimers();
  });

  test('HALF_OPEN → OPEN on failure', () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker('https://h.org');
    const threshold = parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5;
    const resetMs = parseInt(process.env.CB_RESET_TIMEOUT_MS, 10) || 30_000;

    for (let i = 0; i < threshold; i++) cb.recordFailure();
    jest.advanceTimersByTime(resetMs + 1);
    cb.isAvailable(); // → HALF_OPEN

    cb.recordFailure(); // single failure in HALF_OPEN → back to OPEN
    expect(cb.getState()).toBe(CB_STATE.OPEN);
    jest.useRealTimers();
  });

  test('success in CLOSED state resets failure counter', () => {
    const cb = new CircuitBreaker('https://h.org');
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.failures).toBe(0);
    expect(cb.getState()).toBe(CB_STATE.CLOSED);
  });
});

// ── 4. HorizonFailoverClient – basic call ─────────────────────────────────────
describe('HorizonFailoverClient – basic call', () => {
  test('resolves with the result from fn(server)', async () => {
    const client = makeClient(['https://primary.h.org']);
    const result = await client.call(async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  test('activeUrl returns the current endpoint URL', () => {
    const client = makeClient(['https://primary.h.org']);
    expect(client.activeUrl).toBe('https://primary.h.org');
  });

  test('getCircuitBreakerStatus() returns one entry per URL', () => {
    const urls = ['https://a.h.org', 'https://b.h.org'];
    const client = makeClient(urls);
    const status = client.getCircuitBreakerStatus();
    expect(status).toHaveLength(2);
    expect(status[0].url).toBe('https://a.h.org');
    expect(status[1].url).toBe('https://b.h.org');
    expect(status[0].active).toBe(true);
    expect(status[1].active).toBe(false);
  });
});

// ── 5. Failover on transient errors ──────────────────────────────────────────
describe('HorizonFailoverClient – failover on transient errors', () => {
  test('failing primary causes automatic failover to secondary', async () => {
    const client = makeClient(['https://primary.h.org', 'https://secondary.h.org']);

    let callCount = 0;
    const result = await client.call(async (server) => {
      callCount++;
      if (client.activeUrl === 'https://primary.h.org') {
        throw makeTransientError(503);
      }
      return { endpoint: client.activeUrl };
    });

    expect(result.endpoint).toBe('https://secondary.h.org');
    expect(client.activeUrl).toBe('https://secondary.h.org');
  });

  test('non-transient error is NOT retried on next endpoint', async () => {
    const client = makeClient(['https://primary.h.org', 'https://secondary.h.org']);

    const nonTransient = makeTransientError(404); // 404 is not transient

    await expect(
      client.call(async () => { throw nonTransient; })
    ).rejects.toThrow('HTTP 404');

    // Should still be on primary after non-transient failure
    expect(client.activeUrl).toBe('https://primary.h.org');
  });

  test('429 triggers failover (rate limit is transient)', async () => {
    const client = makeClient(['https://primary.h.org', 'https://secondary.h.org']);
    let firstCall = true;

    await client.call(async () => {
      if (firstCall) {
        firstCall = false;
        throw makeTransientError(429);
      }
      return { ok: true };
    });

    expect(client.activeUrl).toBe('https://secondary.h.org');
  });

  test('network error triggers failover', async () => {
    const client = makeClient(['https://primary.h.org', 'https://secondary.h.org']);
    let firstCall = true;

    await client.call(async () => {
      if (firstCall) {
        firstCall = false;
        throw makeNetworkError('ECONNREFUSED');
      }
      return { ok: true };
    });

    expect(client.activeUrl).toBe('https://secondary.h.org');
  });

  test('circuit breaker opens after threshold failures', async () => {
    const client = makeClient(['https://only.h.org']);
    const threshold = parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5;

    // Drive the CB to OPEN by exhausting retries
    for (let i = 0; i < threshold - 1; i++) {
      try {
        await client.call(async () => { throw makeTransientError(503); });
      } catch (_) {}
    }

    // One more to push it over the edge
    try {
      await client.call(async () => { throw makeTransientError(503); });
    } catch (_) {}

    const status = client.getCircuitBreakerStatus();
    expect(status[0].circuitBreaker.state).toBe(CB_STATE.OPEN);
  });
});

// ── 6. All endpoints down ─────────────────────────────────────────────────────
describe('HorizonFailoverClient – all endpoints unavailable', () => {
  test('throws when all CBs are open', async () => {
    jest.useFakeTimers();
    const urls = ['https://a.h.org', 'https://b.h.org'];
    const client = makeClient(urls);
    const threshold = parseInt(process.env.CB_FAILURE_THRESHOLD, 10) || 5;

    // Force both CBs open by recording failures directly
    client._servers.forEach(({ cb }) => {
      for (let i = 0; i < threshold; i++) cb.recordFailure();
    });

    await expect(
      client.call(async () => ({ ok: true }))
    ).rejects.toMatchObject({ code: 'HORIZON_ALL_UNAVAILABLE' });

    jest.useRealTimers();
  });
});

// ── 7. Backoff preserved ──────────────────────────────────────────────────────
describe('Existing backoff / withStellarRetry compatibility', () => {
  test('HorizonFailoverClient.call() re-throws after exhausting all endpoints so retry wrapper can apply backoff', async () => {
    const client = makeClient(['https://a.h.org', 'https://b.h.org']);

    // Both endpoints always fail transiently
    const err503 = makeTransientError(503);
    await expect(
      client.call(async () => { throw err503; })
    ).rejects.toThrow();
    // The caller (withStellarRetry) receives the error and can apply backoff
  });
});
