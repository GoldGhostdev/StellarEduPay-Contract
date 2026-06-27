'use strict';

const { metricsAuth } = require('../backend/src/middleware/metricsAuth');

const STRONG_TOKEN = 'a'.repeat(32); // exactly 32 chars — minimum length

function makeReq(authHeader) {
  return { headers: authHeader ? { authorization: authHeader } : {} };
}

function makeRes() {
  let _status;
  const res = {
    status: jest.fn().mockImplementation((s) => { _status = s; return res; }),
    set:    jest.fn().mockReturnThis(),
    send:   jest.fn().mockReturnThis(),
    _getStatus: () => _status,
  };
  return res;
}

const originalEnv = process.env.METRICS_TOKEN;
afterEach(() => {
  if (originalEnv === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = originalEnv;
});

describe('metricsAuth', () => {
  test('returns 500 when METRICS_TOKEN is not set', () => {
    delete process.env.METRICS_TOKEN;
    const res = makeRes();
    metricsAuth(makeReq(), res, jest.fn());
    expect(res._getStatus()).toBe(500);
  });

  test('returns 500 when METRICS_TOKEN is shorter than 32 chars', () => {
    process.env.METRICS_TOKEN = 'short';
    const res = makeRes();
    metricsAuth(makeReq(), res, jest.fn());
    expect(res._getStatus()).toBe(500);
  });

  test('returns 401 when no Authorization header', () => {
    process.env.METRICS_TOKEN = STRONG_TOKEN;
    const res = makeRes();
    metricsAuth(makeReq(), res, jest.fn());
    expect(res._getStatus()).toBe(401);
  });

  test('returns 403 when wrong token provided', () => {
    process.env.METRICS_TOKEN = STRONG_TOKEN;
    const res = makeRes();
    metricsAuth(makeReq(`Bearer ${'b'.repeat(32)}`), res, jest.fn());
    expect(res._getStatus()).toBe(403);
  });

  test('calls next() when correct token provided', () => {
    process.env.METRICS_TOKEN = STRONG_TOKEN;
    const next = jest.fn();
    metricsAuth(makeReq(`Bearer ${STRONG_TOKEN}`), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('returns 401 when Authorization does not start with Bearer', () => {
    process.env.METRICS_TOKEN = STRONG_TOKEN;
    const res = makeRes();
    metricsAuth(makeReq(`Basic ${STRONG_TOKEN}`), res, jest.fn());
    expect(res._getStatus()).toBe(401);
  });
});
