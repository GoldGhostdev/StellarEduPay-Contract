'use strict';

const { buildWebhookPayload, DEFAULT_ALLOWED_FIELDS, ALL_KNOWN_FIELDS } = require('../src/utils/buildWebhookPayload');

const FULL_PAYLOAD = {
  event: 'payment.confirmed',
  txHash: 'abc123',
  transactionHash: 'abc123',
  amount: 100,
  assetCode: 'XLM',
  asset: 'XLM',
  status: 'confirmed',
  schoolId: 'SCH-1',
  ts: '2026-01-01T00:00:00.000Z',
  timestamp: '2026-01-01T00:00:00.000Z',
  correlationId: 'corr-1',
  referenceCode: 'REF-1',
  finalFee: 100,
  feeValidationStatus: 'exact',
  confirmedAt: '2026-01-01T00:00:00.000Z',
  studentId: 'STU-001',       // PII
  senderAddress: 'GXXXXX',    // PII
};

describe('buildWebhookPayload — default (no PII)', () => {
  test('excludes studentId by default', () => {
    const result = buildWebhookPayload(FULL_PAYLOAD, null);
    expect(result).not.toHaveProperty('studentId');
  });

  test('excludes senderAddress by default', () => {
    const result = buildWebhookPayload(FULL_PAYLOAD, null);
    expect(result).not.toHaveProperty('senderAddress');
  });

  test('includes safe fields by default', () => {
    const result = buildWebhookPayload(FULL_PAYLOAD, null);
    expect(result).toHaveProperty('txHash', 'abc123');
    expect(result).toHaveProperty('amount', 100);
    expect(result).toHaveProperty('schoolId', 'SCH-1');
  });

  test('empty allowedFields falls back to default', () => {
    const result = buildWebhookPayload(FULL_PAYLOAD, []);
    expect(result).not.toHaveProperty('studentId');
    expect(result).not.toHaveProperty('senderAddress');
  });
});

describe('buildWebhookPayload — opt-in to PII fields', () => {
  test('includes studentId when opted in', () => {
    const result = buildWebhookPayload(FULL_PAYLOAD, [...DEFAULT_ALLOWED_FIELDS, 'studentId']);
    expect(result).toHaveProperty('studentId', 'STU-001');
  });

  test('includes senderAddress when opted in', () => {
    const result = buildWebhookPayload(FULL_PAYLOAD, [...DEFAULT_ALLOWED_FIELDS, 'senderAddress']);
    expect(result).toHaveProperty('senderAddress', 'GXXXXX');
  });

  test('can include both PII fields simultaneously', () => {
    const result = buildWebhookPayload(FULL_PAYLOAD, [...DEFAULT_ALLOWED_FIELDS, 'studentId', 'senderAddress']);
    expect(result).toHaveProperty('studentId');
    expect(result).toHaveProperty('senderAddress');
  });
});

describe('buildWebhookPayload — does not mutate input', () => {
  test('original payload is unchanged after call', () => {
    const original = { ...FULL_PAYLOAD };
    buildWebhookPayload(FULL_PAYLOAD, ['event']);
    expect(FULL_PAYLOAD).toEqual(original);
  });
});

describe('buildWebhookPayload — edge cases', () => {
  test('returns empty object for null payload', () => {
    expect(buildWebhookPayload(null, null)).toEqual({});
  });

  test('returns empty object for non-object payload', () => {
    expect(buildWebhookPayload('string', null)).toEqual({});
  });

  test('only returns keys present in allowedFields AND payload', () => {
    const result = buildWebhookPayload({ txHash: 'abc' }, ['txHash', 'amount']);
    expect(result).toHaveProperty('txHash', 'abc');
    expect(result).not.toHaveProperty('amount'); // not in payload
  });
});

describe('ALL_KNOWN_FIELDS', () => {
  test('includes studentId', () => expect(ALL_KNOWN_FIELDS).toContain('studentId'));
  test('includes senderAddress', () => expect(ALL_KNOWN_FIELDS).toContain('senderAddress'));
  test('includes all DEFAULT_ALLOWED_FIELDS', () => {
    for (const f of DEFAULT_ALLOWED_FIELDS) {
      expect(ALL_KNOWN_FIELDS).toContain(f);
    }
  });
});
