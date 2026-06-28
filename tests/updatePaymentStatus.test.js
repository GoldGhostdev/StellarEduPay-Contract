'use strict';

process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/**
 * Tests for PATCH /api/payments/:txHash/status
 *
 * Covers:
 *   1. SUCCESS  → DISPUTED succeeds and returns updated payment.
 *   2. PENDING  → FAILED   succeeds and returns updated payment.
 *   3. DISPUTED → REFUNDED succeeds with admin override ($locals.adminOverride).
 *   4. Audit log entry is created on successful update.
 *   5. Returns 400 INVALID_TRANSITION for a disallowed transition.
 *   6. Returns 404 NOT_FOUND when txHash does not exist.
 *   7. Returns 400 VALIDATION_ERROR when status or reason is missing.
 *   8. Returns 400 INVALID_TRANSITION for FAILED → SUCCESS (disallowed in model).
 */

jest.mock('../backend/src/models/paymentModel');
jest.mock('../backend/src/models/receiptModel', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../backend/src/services/receiptService', () => ({ createReceipt: jest.fn() }));
jest.mock('../backend/src/metrics', () => ({
  syncDurationSeconds: { startTimer: jest.fn(() => jest.fn()) },
  paymentVerifiedTotal: { inc: jest.fn() },
}));
jest.mock('../backend/src/services/auditService', () => ({ logAudit: jest.fn() }));
jest.mock('../backend/src/utils/logger', () => ({
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../backend/src/services/stellarService', () => ({
  verifyTransaction: jest.fn(),
  syncPaymentsForSchool: jest.fn(),
  recordPayment: jest.fn(),
  finalizeConfirmedPayments: jest.fn(),
  validatePaymentWithDynamicFee: jest.fn(),
}));
jest.mock('../backend/src/services/sseService', () => ({
  addClient: jest.fn(),
  removeClient: jest.fn(),
  broadcastToSchool: jest.fn(),
}));

const Payment = require('../backend/src/models/paymentModel');
const { logAudit } = require('../backend/src/services/auditService');
const { updatePaymentStatus } = require('../backend/src/controllers/paymentAdminController');

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

/**
 * Build a minimal Mongoose-like document with $locals and save().
 * The controller mutates the document and calls save(), which returns the updated doc.
 */
function makePaymentDoc(status) {
  const doc = {
    txHash: TX,
    status,
    schoolId: 'SCH-001',
    $locals: {},
  };
  // save() resolves with the mutated doc so res.json receives it
  doc.save = jest.fn().mockImplementation(() => Promise.resolve({ ...doc }));
  return doc;
}

beforeEach(() => jest.clearAllMocks());

// ── 1. SUCCESS → DISPUTED ─────────────────────────────────────────────────────

test('transitions SUCCESS → DISPUTED and returns updated payment', async () => {
  const doc = makePaymentDoc('SUCCESS');
  Payment.findOne.mockResolvedValue(doc);

  const res  = makeRes();
  const next = jest.fn();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'DISPUTED', reason: 'Wrong student' }), res, next);

  expect(doc.$locals.adminOverride).toBe(true);
  expect(doc.status).toBe('DISPUTED');
  expect(doc.save).toHaveBeenCalled();
  expect(res.json).toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

// ── 2. PENDING → FAILED ───────────────────────────────────────────────────────

test('transitions PENDING → FAILED and returns updated payment', async () => {
  const doc = makePaymentDoc('PENDING');
  Payment.findOne.mockResolvedValue(doc);

  const res = makeRes();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'FAILED', reason: 'Incorrect memo' }), res, jest.fn());

  expect(doc.status).toBe('FAILED');
  expect(doc.save).toHaveBeenCalled();
  expect(res.json).toHaveBeenCalled();
});

// ── 3. DISPUTED → REFUNDED (admin-only path) ──────────────────────────────────

test('transitions DISPUTED → REFUNDED with admin override', async () => {
  const doc = makePaymentDoc('DISPUTED');
  Payment.findOne.mockResolvedValue(doc);

  const res  = makeRes();
  const next = jest.fn();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'REFUNDED', reason: 'Dispute resolved' }), res, next);

  expect(doc.$locals.adminOverride).toBe(true);
  expect(doc.status).toBe('REFUNDED');
  expect(doc.save).toHaveBeenCalled();
  expect(res.json).toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

// ── 4. Audit log created ──────────────────────────────────────────────────────

test('creates an audit log entry on successful status update', async () => {
  const doc = makePaymentDoc('SUCCESS');
  Payment.findOne.mockResolvedValue(doc);

  await updatePaymentStatus(
    makeReq({ txHash: TX }, { status: 'DISPUTED', reason: 'Fraud suspected' }),
    makeRes(),
    jest.fn(),
  );

  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
    schoolId:    'SCH-001',
    action:      'payment_status_update',
    performedBy: 'admin@school.edu',
    targetId:    TX,
    targetType:  'payment',
    result:      'success',
    details: expect.objectContaining({
      from:          'SUCCESS',
      to:            'DISPUTED',
      reason:        'Fraud suspected',
      adminOverride: true,
    }),
  }));
});

// ── 5. Disallowed transition ──────────────────────────────────────────────────

test('returns 400 INVALID_TRANSITION for a disallowed status change', async () => {
  const doc = makePaymentDoc('FAILED');
  Payment.findOne.mockResolvedValue(doc);

  const res  = makeRes();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'SUCCESS', reason: 'Reversal' }), res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
  expect(doc.save).not.toHaveBeenCalled();
});

// ── 6. Payment not found ──────────────────────────────────────────────────────

test('calls next with NOT_FOUND when txHash does not exist', async () => {
  Payment.findOne.mockResolvedValue(null);

  const next = jest.fn();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'FAILED', reason: 'x' }), makeRes(), next);

  expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
});

// ── 7. Missing fields ─────────────────────────────────────────────────────────

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

// ── 8. Cannot transition to PENDING ──────────────────────────────────────────

test('returns 400 INVALID_TRANSITION when targeting PENDING status', async () => {
  const res  = makeRes();
  await updatePaymentStatus(makeReq({ txHash: TX }, { status: 'PENDING', reason: 'Reset' }), res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
});
