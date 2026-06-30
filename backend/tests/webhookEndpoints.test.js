'use strict';

/**
 * Tests for #865 — WebhookEndpoint model, delivery log, and dispatch logic.
 * Tests pure/exported functions only; no HTTP client needed.
 */

jest.mock('../src/models/webhookEndpointModel', () => ({}));
jest.mock('../src/models/webhookDeliveryModel', () => ({}));
jest.mock('../src/models/webhookRetryModel', () => ({}));
jest.mock('../src/utils/validateWebhookUrl', () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue({ valid: true, resolvedIps: ['1.2.3.4'] }),
  validateResolvedIp: jest.fn().mockReturnValue({ blocked: false }),
}));
jest.mock('../src/utils/buildWebhookPayload', () => ({
  buildWebhookPayload: jest.fn((payload) => payload),
}));
jest.mock('../src/config/redisClient', () => ({
  getRedisClient: jest.fn(),
  isRedisReady: jest.fn(() => false),
}));
jest.mock('../src/utils/logger', () => {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  logger.child = () => logger;
  return logger;
});
jest.mock('../src/metrics/webhookMetrics', () => ({
  recordDeliverySuccess: jest.fn(),
  recordDeliveryFailure: jest.fn(),
  refreshDeadLetterGauge: jest.fn().mockResolvedValue(undefined),
}));
// Mock axios as a virtual module (doesn't need to exist on disk)
jest.mock('axios', () => ({
  create: jest.fn(() => ({
    post: jest.fn().mockResolvedValue({ status: 200, data: 'ok' }),
  })),
}), { virtual: true });

const WebhookDelivery = require('../src/models/webhookDeliveryModel');
const WebhookEndpoint = require('../src/models/webhookEndpointModel');
const WebhookRetry = require('../src/models/webhookRetryModel');
const { buildWebhookPayload } = require('../src/utils/buildWebhookPayload');
const { validateWebhookUrl } = require('../src/utils/validateWebhookUrl');

// ── _writeDeliveryLog — pure function, no HTTP ────────────────────────────────

describe('_writeDeliveryLog', () => {
  beforeEach(() => {
    WebhookDelivery.create = jest.fn().mockResolvedValue({});
    jest.clearAllMocks();
  });

  test('creates a delivery document on success', async () => {
    const { _writeDeliveryLog } = require('../src/services/webhookService');
    await _writeDeliveryLog({
      endpointId: 'ep1', schoolId: 'SCH-1', deliveryId: 'del-1',
      event: 'payment.confirmed', payload: { txHash: 'abc' },
      statusCode: 200, responseBody: 'ok', success: true,
      attemptCount: 1, durationMs: 120, error: null,
    });
    expect(WebhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, statusCode: 200 })
    );
  });

  test('creates a delivery document on failure', async () => {
    const { _writeDeliveryLog } = require('../src/services/webhookService');
    await _writeDeliveryLog({
      endpointId: 'ep1', schoolId: 'SCH-1', deliveryId: 'del-2',
      event: 'payment.failed', payload: { txHash: 'xyz' },
      statusCode: 500, responseBody: 'error', success: false,
      attemptCount: 1, durationMs: 200, error: 'HTTP 500',
    });
    expect(WebhookDelivery.create).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'HTTP 500' })
    );
  });

  test('truncates responseBody to 1024 chars', async () => {
    const { _writeDeliveryLog } = require('../src/services/webhookService');
    await _writeDeliveryLog({
      endpointId: 'ep1', schoolId: 'SCH-1', deliveryId: 'del-3',
      event: 'payment.confirmed', payload: {}, statusCode: 200,
      responseBody: 'x'.repeat(2000), success: true, attemptCount: 1, durationMs: 50, error: null,
    });
    const call = WebhookDelivery.create.mock.calls[0][0];
    expect(call.responseBody.length).toBe(1024);
  });

  test('does not throw when WebhookDelivery.create fails', async () => {
    WebhookDelivery.create = jest.fn().mockRejectedValue(new Error('DB error'));
    const { _writeDeliveryLog } = require('../src/services/webhookService');
    await expect(
      _writeDeliveryLog({
        endpointId: 'ep1', schoolId: 'SCH-1', deliveryId: 'del-4',
        event: 'payment.confirmed', payload: {}, statusCode: 200,
        responseBody: null, success: true, attemptCount: 1, durationMs: 10, error: null,
      })
    ).resolves.not.toThrow();
  });
});

// ── fireWebhookToEndpoints — empty endpoint list ──────────────────────────────

describe('fireWebhookToEndpoints — no matching endpoints', () => {
  beforeEach(() => {
    WebhookDelivery.create = jest.fn().mockResolvedValue({});
    WebhookRetry.create = jest.fn().mockResolvedValue({});
    WebhookEndpoint.find = jest.fn().mockReturnValue({
      lean: () => Promise.resolve([]),
    });
  });

  test('returns empty array when no active endpoints match', async () => {
    const { fireWebhookToEndpoints, _resetNonces } = require('../src/services/webhookService');
    _resetNonces();
    const results = await fireWebhookToEndpoints('SCH-1', 'payment.confirmed', { txHash: 'abc' });
    expect(results).toHaveLength(0);
  });
});

// ── fireWebhookToEndpoints — URL validation failure ───────────────────────────

describe('fireWebhookToEndpoints — URL validation failure', () => {
  beforeEach(() => {
    WebhookDelivery.create = jest.fn().mockResolvedValue({});
    WebhookRetry.create = jest.fn().mockResolvedValue({});
    WebhookEndpoint.find = jest.fn().mockReturnValue({
      lean: () => Promise.resolve([
        { _id: 'ep1', schoolId: 'SCH-1', url: 'https://internal.local/hook',
          secret: 'sec', subscribedEvents: ['payment.confirmed'], isActive: true },
      ]),
    });
    validateWebhookUrl.mockResolvedValue({ valid: false, reason: 'INVALID_WEBHOOK_URL' });
  });

  test('skips endpoint and records failure when URL validation fails', async () => {
    const { fireWebhookToEndpoints, _resetNonces } = require('../src/services/webhookService');
    _resetNonces();
    const results = await fireWebhookToEndpoints('SCH-1', 'payment.confirmed', { txHash: 'abc' });
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('URL_VALIDATION_FAILED');
  });
});

// ── fireWebhookToEndpoints — PII filtering ────────────────────────────────────

describe('fireWebhookToEndpoints — PII filtering', () => {
  test('calls buildWebhookPayload with provided allowedFields', async () => {
    WebhookEndpoint.find = jest.fn().mockReturnValue({
      lean: () => Promise.resolve([]),
    });
    buildWebhookPayload.mockImplementation((p) => p);

    const { fireWebhookToEndpoints, _resetNonces } = require('../src/services/webhookService');
    _resetNonces();
    const payload = { txHash: 'abc', studentId: 'STU-1', senderAddress: 'GXXX' };
    await fireWebhookToEndpoints('SCH-1', 'payment.confirmed', payload, ['txHash', 'event']);
    expect(buildWebhookPayload).toHaveBeenCalledWith(payload, ['txHash', 'event']);
  });
});
