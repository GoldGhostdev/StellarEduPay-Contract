'use strict';

// Required before any module that loads config/index.js
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/**
 * Tests for PATCH /api/payments/:txHash/status
 *
 * Covers:
 *   1. SUCCESS → DISPUTED succeeds and returns updated payment.
 *   2. PENDING  → FAILED   succeeds and returns updated payment.
 *   3. Audit log entry is created on successful update.
 *   4. Returns 400 INVALID_TRANSITION for a disallowed transition.
 *   5. Returns 404 NOT_FOUND when txHash does not exist.
 *   6. Returns 400 VALIDATION_ERROR when status or reason is missing.
 */

jest.mock('../backend/src/models/paymentModel');
jest.mock('../backend/src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../backend/src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ACCEPTED_ASSETS: {},
  server: { transactions: jest.fn() },
}));
jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction: jest.fn(),
  syncPaymentsForSchool: jest.fn(),
  recordPayment: jest.fn(),
  finalizeConfirmedPayments: jest.fn(),
  validatePaymentWithDynamicFee: jest.fn(),
}));
jest.mock('../backend/src/services/retryService', () => ({ queueForRetry: jest.fn() }));
jest.mock('../backend/src/queue/transactionQueue', () => ({ enqueueTransaction: jest.fn(), getJobStatus: jest.fn() }));
jest.mock('../backend/src/models/paymentIntentModel', () => ({ findOne: jest.fn(), create: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../backend/src/models/studentModel', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../backend/src/models/pendingVerificationModel', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../backend/src/services/currencyConversionService', () => ({ enrichPaymentWithConversion: jest.fn() }));
jest.mock('../backend/src/services/sseService', () => ({ addClient: jest.fn(), removeClient: jest.fn(), broadcastToSchool: jest.fn() }));

const Payment = require('../backend/src/models/paymentModel');
const { logAudit } = require('../backend/src/services/auditService');
const { updatePaymentStatus } = require('../backend/src/controllers/paymentController');

const TX = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';

function makeReq(params, body) {
  return {
    params,
    body,
    schoolId: 'SCH-001',
    auditContext: { performedBy: 'admin@school.edu', ipAddress: '127.0.0.1', userAgent: 'jest' },
  };
}

function makeRes() {
  const res = {};
  res.json   = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => jest.clearAllMocks());

// ── 1. SUCCESS → DISPUTED ─────────────────────────────────────────────────────

test('transitions SUCCESS → DISPUTED and returns updated payment', async () => {
  const original = { txHash: TX, status: 'SUCCESS', schoolId: 'SCH-001' };
  const updated  = { ...original, status: 'DISPUTED' };
  Payment.findOne.mockReturnValue({ lean: () => Promise.resolve(original) });
  Payment.findOneAndUpdate.mockResolvedValue(updated);

  const res  = makeRes();
  const next = jest.fn();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'DISPUTED', reason: 'Wrong student matched' }), res, next);

  expect(Payment.findOneAndUpdate).toHaveBeenCalledWith(
    { schoolId: 'SCH-001', txHash: TX },
    { $set: { status: 'DISPUTED' } },
    { new: true },
  );
  expect(res.json).toHaveBeenCalledWith(updated);
  expect(next).not.toHaveBeenCalled();
});

// ── 2. PENDING → FAILED ───────────────────────────────────────────────────────

test('transitions PENDING → FAILED and returns updated payment', async () => {
  const original = { txHash: TX, status: 'PENDING', schoolId: 'SCH-001' };
  const updated  = { ...original, status: 'FAILED' };
  Payment.findOne.mockReturnValue({ lean: () => Promise.resolve(original) });
  Payment.findOneAndUpdate.mockResolvedValue(updated);

  const res  = makeRes();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'FAILED', reason: 'Incorrect memo' }), res, jest.fn());

  expect(res.json).toHaveBeenCalledWith(updated);
});

// ── 3. Audit log created ──────────────────────────────────────────────────────

test('creates an audit log entry on successful status update', async () => {
  const original = { txHash: TX, status: 'SUCCESS', schoolId: 'SCH-001' };
  Payment.findOne.mockReturnValue({ lean: () => Promise.resolve(original) });
  Payment.findOneAndUpdate.mockResolvedValue({ ...original, status: 'DISPUTED' });

  await updatePaymentStatus(
    makeReq({ txHash: TX }, { status: 'DISPUTED', reason: 'Fraud suspected' }),
    makeRes(),
    jest.fn(),
  );

  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
    schoolId: 'SCH-001',
    action: 'payment_status_update',
    performedBy: 'admin@school.edu',
    targetId: TX,
    targetType: 'payment',
    details: { from: 'SUCCESS', to: 'DISPUTED', reason: 'Fraud suspected' },
    result: 'success',
  }));
});

// ── 4. Disallowed transition ──────────────────────────────────────────────────

test('returns 400 INVALID_TRANSITION for a disallowed status change', async () => {
  const original = { txHash: TX, status: 'FAILED', schoolId: 'SCH-001' };
  Payment.findOne.mockReturnValue({ lean: () => Promise.resolve(original) });

  const res  = makeRes();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'SUCCESS', reason: 'Reversal' }), res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  expect(Payment.findOneAndUpdate).not.toHaveBeenCalled();
});

// ── 5. Payment not found ──────────────────────────────────────────────────────

test('calls next with NOT_FOUND when txHash does not exist', async () => {
  Payment.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });

  const next = jest.fn();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'FAILED', reason: 'x' }), makeRes(), next);

  expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
});

// ── 6. Missing fields ─────────────────────────────────────────────────────────

test('returns 400 VALIDATION_ERROR when status is missing', async () => {
  const res  = makeRes();
  await updatePaymentStatus(makeReq({ txHash: TX }, { reason: 'x' }), res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
});

test('returns 400 VALIDATION_ERROR when reason is missing', async () => {
  const res  = makeRes();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'FAILED' }), res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
});
