'use strict';

/**
 * Tests for Issue #71 — query validation (date range cap + no ReDoS).
 *
 * Acceptance criteria:
 *   1. Date ranges exceeding MAX_RANGE_DAYS are rejected with 400.
 *   2. Malformed (non-ISO) dates are rejected with 400.
 *   3. startDate > endDate is rejected with 400.
 *   4. status filters are validated against the enum — arbitrary strings are
 *      rejected, preventing them from reaching MongoDB.
 *   5. No user-supplied string ever becomes an unescaped $regex in a query.
 */

const Joi = require('joi');

process.env.MONGO_URI = 'mongodb://localhost/test';
process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long';

const {
  getAllPaymentsSchema,
  MAX_RANGE_DAYS,
} = require('../src/middleware/schemas/paymentQuerySchemas');

const { validate } = require('../src/middleware/validate');

// ── Helper ────────────────────────────────────────────────────────────────────

function runSchema(query) {
  const { error, value } = getAllPaymentsSchema.validate(query, {
    abortEarly: false,
    convert: true,
  });
  return { error, value };
}

function toDateStr(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

// ── Date range cap ───────────────────────────────────────────────────────────

describe('Issue #71 — date range cap', () => {
  it(`rejects a date range greater than ${MAX_RANGE_DAYS} days`, () => {
    const { error } = runSchema({
      startDate: toDateStr(-(MAX_RANGE_DAYS + 10)),
      endDate:   toDateStr(10),
    });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/Date range exceeds/);
  });

  it('accepts a date range equal to MAX_RANGE_DAYS', () => {
    const { error } = runSchema({
      startDate: toDateStr(-MAX_RANGE_DAYS),
      endDate:   toDateStr(0),
    });
    expect(error).toBeUndefined();
  });

  it('accepts a short date range', () => {
    const { error } = runSchema({
      startDate: toDateStr(-7),
      endDate:   toDateStr(0),
    });
    expect(error).toBeUndefined();
  });

  it('rejects startDate after endDate', () => {
    const { error } = runSchema({
      startDate: toDateStr(5),
      endDate:   toDateStr(0),
    });
    expect(error).toBeDefined();
    expect(error.message).toMatch(/startDate must be before/);
  });

  it('allows omitting dates entirely', () => {
    const { error } = runSchema({});
    expect(error).toBeUndefined();
  });

  it('allows only startDate (no range check needed)', () => {
    const { error } = runSchema({ startDate: toDateStr(-10) });
    expect(error).toBeUndefined();
  });
});

// ── Date format validation ────────────────────────────────────────────────────

describe('Issue #71 — date format validation', () => {
  const badDates = [
    'not-a-date',
    '32/13/2026',
    '2026-13-01',
    '2026-00-01',
    '20260101',
    'yesterday',
    "'; DROP TABLE payments; --",
    '<script>alert(1)</script>',
    '',
  ];

  badDates.forEach((bad) => {
    it(`rejects malformed startDate: "${bad}"`, () => {
      const { error } = runSchema({ startDate: bad });
      expect(error).toBeDefined();
    });

    it(`rejects malformed endDate: "${bad}"`, () => {
      const { error } = runSchema({ endDate: bad });
      expect(error).toBeDefined();
    });
  });

  it('accepts a valid ISO date string for startDate', () => {
    const { error } = runSchema({ startDate: '2026-01-01' });
    expect(error).toBeUndefined();
  });

  it('accepts a valid ISO datetime string for endDate', () => {
    const { error } = runSchema({ endDate: '2026-12-31T23:59:59.000Z' });
    expect(error).toBeUndefined();
  });
});

// ── Status enum validation ───────────────────────────────────────────────────

describe('Issue #71 — status enum validation prevents regex injection', () => {
  const validStatuses = ['PENDING', 'SUCCESS', 'FAILED', 'SUBMITTED', 'DISPUTED', 'REFUNDED', 'INVALID'];
  const invalidStatuses = [
    '.*',                     // regex wildcard
    '(a+)+',                  // catastrophic backtracking regex
    "'; DROP TABLE --",       // SQL injection attempt
    '<script>alert()</script>',
    'UNKNOWN_STATUS',
    '',
  ];

  validStatuses.forEach((s) => {
    it(`accepts valid status "${s}"`, () => {
      const { error } = runSchema({ status: s });
      expect(error).toBeUndefined();
    });
  });

  invalidStatuses.forEach((s) => {
    it(`rejects invalid status "${s}"`, () => {
      const { error } = runSchema({ status: s });
      expect(error).toBeDefined();
    });
  });
});

// ── No $regex in controller queries ──────────────────────────────────────────

describe('Issue #71 — no unescaped $regex in getAllPayments query filter', () => {
  // These mocks let us inspect what MongoDB filter the controller assembles.
  let capturedFilter = null;

  const mockChain = {
    sort: () => mockChain,
    skip: () => mockChain,
    limit: () => mockChain,
    lean: () => Promise.resolve([]),
  };

  beforeEach(() => {
    capturedFilter = null;
    jest.resetModules();

    jest.mock('../src/models/paymentModel', () => ({
      find: (filter) => { capturedFilter = filter; return mockChain; },
      countDocuments: () => Promise.resolve(0),
    }));
    jest.mock('../src/models/studentModel', () => ({ findOne: jest.fn() }));
    jest.mock('../src/services/currencyConversionService', () => ({
      enrichPaymentWithConversion: async (p) => p,
    }));
    jest.mock('../src/config/stellarConfig', () => ({ ACCEPTED_ASSETS: {} }));
    jest.mock('../src/utils/paymentLimits', () => ({ getPaymentLimits: () => ({ min: 0, max: 1e6 }) }));
    jest.mock('../src/utils/logger', () => ({
      child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
      info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
  });

  it('studentId filter never creates a $regex — stored as literal string', async () => {
    const { getAllPayments } = require('../src/controllers/paymentQueryController');

    const req = {
      schoolId: 'school-1',
      school: { localCurrency: 'USD' },
      query: { studentId: 'stu(001)' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await getAllPayments(req, res, jest.fn());

    // The filter must NOT contain a $regex for the studentId key.
    expect(capturedFilter).not.toBeNull();
    // studentId must be a plain string — not an object with $regex.
    expect(typeof capturedFilter.studentId).toBe('string');
    // It must be the literal string that was passed.
    expect(capturedFilter.studentId).toBe('stu(001)');
  });

  it('status filter is the uppercased enum string, not a regex', async () => {
    const { getAllPayments } = require('../src/controllers/paymentQueryController');

    const req = {
      schoolId: 'school-1',
      school: { localCurrency: 'USD' },
      query: { status: 'success' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await getAllPayments(req, res, jest.fn());

    expect(capturedFilter.status).toBe('SUCCESS');
    // Must be a plain string, not a $regex operator object.
    expect(typeof capturedFilter.status).toBe('string');
  });
});

// ── getAllPayments schema rejects oversized date ranges ──────────────────────

describe('Issue #71 — getAllPaymentsSchema rejects oversized date ranges', () => {
  it('returns a validation error for a range exceeding MAX_RANGE_DAYS', () => {
    const maxDays = parseInt(process.env.REPORT_MAX_RANGE_DAYS || '366', 10);
    const start = new Date();
    start.setFullYear(start.getFullYear() - 5); // 5 years: well over 366 days
    const end = new Date();

    const { error } = runSchema({
      startDate: start.toISOString().slice(0, 10),
      endDate:   end.toISOString().slice(0, 10),
    });

    expect(error).toBeDefined();
    expect(error.message).toMatch(/Date range exceeds/);
  });
});
