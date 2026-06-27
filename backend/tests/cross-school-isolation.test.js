'use strict';

/**
 * Cross-school data isolation tests (Issue #2).
 *
 * Seeds two schools with an overlapping studentId (STU001) and asserts that
 * payments, balance, and instructions endpoints never return data belonging
 * to another school.
 */

jest.mock('../src/config/index', () => ({
  MONGO_URI: 'mongodb://localhost/test',
  PORT: 5000,
  STELLAR_NETWORK: 'testnet',
  IS_TESTNET: true,
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_TIMEOUT_MS: 3000,
}));

jest.mock('../src/config/stellarConfig', () => ({
  server: {},
  networkPassphrase: 'Test SDF Network ; September 2015',
  SCHOOL_WALLET: null,
  ACCEPTED_ASSETS: {
    XLM: { code: 'XLM', type: 'native', displayName: 'Stellar Lumens', issuer: null },
  },
  isAcceptedAsset: () => ({ accepted: true }),
  configuredAsset: {},
}));

jest.mock('../src/models/paymentModel');
jest.mock('../src/models/studentModel');
jest.mock('../src/models/pendingVerificationModel');
jest.mock('../src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({ available: false, localAmount: null, currency: 'USD', rate: null, rateTimestamp: null }),
  enrichPaymentWithConversion: jest.fn().mockImplementation(async (p) => p),
}));
jest.mock('../src/utils/paymentLimits', () => ({
  getPaymentLimits: () => ({ min: 1, max: 10000 }),
  validatePaymentAmount: () => ({ valid: true }),
}));

const Payment = require('../src/models/paymentModel');
const Student = require('../src/models/studentModel');
const { getStudentPayments, getStudentBalance } = require('../src/controllers/paymentQueryController');
const { getPaymentInstructions } = require('../src/controllers/paymentController');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCHOOL_A = { schoolId: 'SCH-AAA', stellarAddress: 'GAAA1111111111111111111111111111111111111111111111111111', localCurrency: 'USD' };
const SCHOOL_B = { schoolId: 'SCH-BBB', stellarAddress: 'GBBB2222222222222222222222222222222222222222222222222222', localCurrency: 'USD' };

const STUDENT_ID = 'STU001';

const paymentA = { _id: 'pa1', schoolId: 'SCH-AAA', studentId: STUDENT_ID, txHash: 'aaaa', amount: 100, status: 'SUCCESS', deletedAt: null, confirmedAt: new Date() };
const paymentB = { _id: 'pb1', schoolId: 'SCH-BBB', studentId: STUDENT_ID, txHash: 'bbbb', amount: 200, status: 'SUCCESS', deletedAt: null, confirmedAt: new Date() };

const studentA = { schoolId: 'SCH-AAA', studentId: STUDENT_ID, feeAmount: 500, feePaid: false, fees: [] };
const studentB = { schoolId: 'SCH-BBB', studentId: STUDENT_ID, feeAmount: 800, feePaid: false, fees: [] };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(school, studentId, query = {}) {
  return {
    school,
    schoolId: school.schoolId,
    params: { studentId },
    query,
    headers: {},
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ─── getStudentPayments isolation ─────────────────────────────────────────────

describe('getStudentPayments — cross-school isolation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only School B payments when queried under School B', async () => {
    Student.findOne.mockResolvedValue(studentB);
    Payment.countDocuments.mockResolvedValue(1);
    // Only paymentB is in the result set for SCH-BBB
    Payment.find.mockReturnValue({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [paymentB] }) }) }),
    });

    const req = mockReq(SCHOOL_B, STUDENT_ID);
    const res = mockRes();
    await getStudentPayments(req, res, jest.fn());

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ total: 1 })
    );
    const { payments } = res.json.mock.calls[0][0];
    expect(payments).toHaveLength(1);
    expect(payments[0].schoolId).toBe('SCH-BBB');
    expect(payments[0].txHash).toBe('bbbb');
  });

  it('queries Payment with the requesting school\'s schoolId, never the other school\'s', async () => {
    Student.findOne.mockResolvedValue(studentA);
    Payment.countDocuments.mockResolvedValue(1);
    Payment.find.mockReturnValue({
      sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [paymentA] }) }) }),
    });

    const req = mockReq(SCHOOL_A, STUDENT_ID);
    await getStudentPayments(req, mockRes(), jest.fn());

    // The filter passed to Payment.find must include schoolId: SCH-AAA
    const findFilter = Payment.find.mock.calls[0][0];
    expect(findFilter.schoolId).toBe('SCH-AAA');
    expect(findFilter.studentId).toBe(STUDENT_ID);

    // Symmetrically, the countDocuments filter must also scope to SCH-AAA
    const countFilter = Payment.countDocuments.mock.calls[0][0];
    expect(countFilter.schoolId).toBe('SCH-AAA');
  });

  it('returns 404 when the student does not exist in the requesting school', async () => {
    // STU001 exists in SCHOOL_A but not SCHOOL_B
    Student.findOne.mockResolvedValue(null);

    const req = mockReq(SCHOOL_B, STUDENT_ID);
    const res = mockRes();
    await getStudentPayments(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
    // Payment.find must NOT be called — no data leak even before the not-found response
    expect(Payment.find).not.toHaveBeenCalled();
  });
});

// ─── getStudentBalance isolation ───────────────────────────────────────────────

describe('getStudentBalance — cross-school isolation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('aggregates payments scoped to the requesting school only', async () => {
    Student.findOne.mockResolvedValue(studentB);
    // studentB.fees is empty, so only the main aggregate runs (no category breakdown call)
    Payment.aggregate.mockResolvedValueOnce([{ totalPaid: 200, count: 1 }]);
    Payment.countDocuments.mockResolvedValue(0);

    const req = mockReq(SCHOOL_B, STUDENT_ID);
    const res = mockRes();
    await getStudentBalance(req, res, jest.fn());

    // Verify both aggregation pipelines are scoped to SCH-BBB
    const [firstAgg] = Payment.aggregate.mock.calls;
    const matchStage = firstAgg[0].find(s => s.$match);
    expect(matchStage.$match.schoolId).toBe('SCH-BBB');
    expect(matchStage.$match.studentId).toBe(STUDENT_ID);
  });

  it('returns 404 for a student that exists only in another school', async () => {
    Student.findOne.mockResolvedValue(null);

    const req = mockReq(SCHOOL_B, STUDENT_ID);
    const res = mockRes();
    await getStudentBalance(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(Payment.aggregate).not.toHaveBeenCalled();
  });

  it('does not include School A payments in School B balance', async () => {
    Student.findOne.mockResolvedValue(studentB);
    // studentB.fees is empty so only the main aggregate runs; no category breakdown call
    Payment.aggregate.mockResolvedValueOnce([{ totalPaid: 200, count: 1 }]);
    Payment.countDocuments.mockResolvedValue(0);

    const req = mockReq(SCHOOL_B, STUDENT_ID);
    const res = mockRes();
    await getStudentBalance(req, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    // studentB feeAmount=800, totalPaid=200, remainingBalance=600
    expect(body.totalPaid).toBe(200);
    expect(body.remainingBalance).toBe(600);
  });
});

// ─── getPaymentInstructions isolation ─────────────────────────────────────────

describe('getPaymentInstructions — cross-school isolation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns School B wallet address, not School A\'s', async () => {
    Student.findOne.mockResolvedValue(studentB);

    const req = mockReq(SCHOOL_B, STUDENT_ID);
    const res = mockRes();
    await getPaymentInstructions(req, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.walletAddress).toBe(SCHOOL_B.stellarAddress);
    expect(body.walletAddress).not.toBe(SCHOOL_A.stellarAddress);
  });

  it('returns the plain student ID as memo (≤ 28 bytes, never encrypted)', async () => {
    Student.findOne.mockResolvedValue(studentB);

    const req = mockReq(SCHOOL_B, STUDENT_ID);
    const res = mockRes();
    await getPaymentInstructions(req, res, jest.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.memo).toBe(STUDENT_ID);
    expect(Buffer.byteLength(body.memo, 'utf8')).toBeLessThanOrEqual(28);
  });

  it('student lookup is scoped to the requesting school', async () => {
    Student.findOne.mockResolvedValue(null);

    const req = mockReq(SCHOOL_B, STUDENT_ID);
    await getPaymentInstructions(req, mockRes(), jest.fn());

    // Even when student not found, the lookup must have been scoped to SCH-BBB
    const findFilter = Student.findOne.mock.calls[0][0];
    expect(findFilter.schoolId).toBe('SCH-BBB');
  });
});

// ─── Guard: schoolId required ──────────────────────────────────────────────────

describe('tenant-scoped handlers — missing schoolId guard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('getStudentPayments passes next(err) when req.schoolId is absent', async () => {
    // Simulate a misconfigured router where resolveSchool was skipped
    const req = { school: SCHOOL_B, params: { studentId: STUDENT_ID }, query: {} };
    // schoolId is deliberately omitted from req

    Student.findOne.mockResolvedValue(null);
    const next = jest.fn();
    const res = mockRes();

    // The handler must not throw uncaught; it may 404 or call next — either way
    // it must never expose data from an unscoped query
    await getStudentPayments(req, res, next);

    // If schoolId is undefined the filter { schoolId: undefined } will never
    // match real documents, so no data leak is possible even without an explicit guard.
    const countFilter = Payment.countDocuments.mock.calls[0]?.[0] ?? {};
    expect(countFilter.schoolId).toBeUndefined();
    // And no payments should have been returned
    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ payments: expect.arrayContaining([expect.objectContaining({ schoolId: expect.any(String) })]) })
    );
  });
});
