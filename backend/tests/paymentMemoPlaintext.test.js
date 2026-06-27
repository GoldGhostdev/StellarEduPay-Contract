'use strict';

/**
 * Issue #4 — Confirm payment memo is plaintext student ID end-to-end.
 *
 * Stellar MEMO_TEXT is limited to 28 bytes. getPaymentInstructions must always
 * return the raw student ID (not AES-GCM ciphertext) so that:
 *   1. Wallets can include it without hitting MemoTooLongError.
 *   2. The sync engine can match the on-chain memo to a student record.
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
}));

jest.mock('../src/models/studentModel');
jest.mock('../src/services/currencyConversionService', () => ({
  convertToLocalCurrency: jest.fn().mockResolvedValue({ available: false, localAmount: null, currency: 'USD', rate: null, rateTimestamp: null }),
}));
jest.mock('../src/utils/paymentLimits', () => ({
  getPaymentLimits: () => ({ min: 1, max: 10000 }),
  validatePaymentAmount: () => ({ valid: true }),
}));

const Student = require('../src/models/studentModel');
const { getPaymentInstructions } = require('../src/controllers/paymentController');

const SCHOOL = {
  schoolId: 'SCH-TEST',
  stellarAddress: 'GABC1111111111111111111111111111111111111111111111111111',
  localCurrency: 'USD',
};

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function buildReq(studentId) {
  return { school: SCHOOL, schoolId: SCHOOL.schoolId, params: { studentId }, query: {} };
}

describe('getPaymentInstructions — memo is always plaintext student ID', () => {
  beforeEach(() => jest.clearAllMocks());

  const cases = [
    'STU001',
    'STU-2024-0042',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ12', // exactly 28 ASCII bytes
  ];

  test.each(cases)('memo equals studentId and fits in 28 bytes for "%s"', async (studentId) => {
    Student.findOne.mockResolvedValue(null); // no student record needed for instructions

    const req = buildReq(studentId);
    const res = mockRes();
    await getPaymentInstructions(req, res, jest.fn());

    expect(res.json).toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];

    // Memo must be the raw student ID, not encrypted ciphertext
    expect(body.memo).toBe(studentId);

    // Must fit within Stellar's hard MEMO_TEXT limit
    expect(Buffer.byteLength(body.memo, 'utf8')).toBeLessThanOrEqual(28);
  });

  it('memo type is declared as "text"', async () => {
    Student.findOne.mockResolvedValue(null);
    const res = mockRes();
    await getPaymentInstructions(buildReq('STU001'), res, jest.fn());
    expect(res.json.mock.calls[0][0].memoType).toBe('text');
  });

  it('memo is not base64url (i.e. not encrypted AES-GCM output)', async () => {
    Student.findOne.mockResolvedValue(null);
    const res = mockRes();
    await getPaymentInstructions(buildReq('STU001'), res, jest.fn());

    const { memo } = res.json.mock.calls[0][0];
    // AES-256-GCM output for any input is ≥ 40 chars in base64url.
    // A memo that equals the original student ID cannot be encrypted.
    expect(memo.length).toBeLessThan(40);
    expect(memo).toBe('STU001');
  });
});
