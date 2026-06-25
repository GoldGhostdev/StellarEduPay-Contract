'use strict';

/**
 * Tests for issue #799 — inbound webhook replay protection:
 *   1. Timestamp skew rejection
 *   2. HMAC signature verification
 *   3. Delivery-ID deduplication (replay blocked with 409)
 */

const crypto = require('crypto');

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCreate = jest.fn();
jest.mock('../backend/src/models/webhookDeliveryModel', () => ({
  create: (...a) => mockCreate(...a),
}));

jest.mock('../backend/src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const { validateInboundWebhook, verifySignature, TOLERANCE_SECONDS } = require('../backend/src/middleware/validateInboundWebhook');

const SECRET = 'test-webhook-secret';

function makeReqRes(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { event: 'payment.confirmed', data: {} };
  const rawBody = JSON.stringify(body);
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;

  const req = {
    headers: {
      'x-stellaredupay-timestamp': String(overrides.ts ?? now),
      'x-stellaredupay-signature': overrides.signature ?? signature,
      'x-stellaredupay-delivery-id': overrides.deliveryId ?? 'delivery-abc-123',
    },
    body,
    rawBody,
    ...overrides.req,
  };
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return { req, res };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({});
});

const middleware = validateInboundWebhook(SECRET);

describe('#799 — validateInboundWebhook: timestamp skew', () => {
  it('rejects when timestamp header is missing', async () => {
    const { req, res } = makeReqRes();
    delete req.headers['x-stellaredupay-timestamp'];
    await middleware(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('MISSING_TIMESTAMP');
  });

  it('rejects when timestamp is older than tolerance', async () => {
    const stale = Math.floor(Date.now() / 1000) - TOLERANCE_SECONDS - 60;
    const { req, res } = makeReqRes({ ts: stale });
    await middleware(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe('TIMESTAMP_SKEW');
  });

  it('passes a fresh timestamp', async () => {
    const next = jest.fn();
    const { req, res } = makeReqRes();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(400);
  });
});

describe('#799 — validateInboundWebhook: signature verification', () => {
  it('rejects an invalid signature', async () => {
    const { req, res } = makeReqRes({ signature: 'sha256=deadbeef00000000' });
    await middleware(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe('INVALID_SIGNATURE');
  });

  it('accepts a valid HMAC-SHA256 signature', async () => {
    const next = jest.fn();
    const { req, res } = makeReqRes();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('verifySignature helper returns true for correct sig and false for tampered', () => {
    const body = 'hello';
    const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
    expect(verifySignature(body, sig, SECRET)).toBe(true);
    expect(verifySignature(body, 'sha256=badhex', SECRET)).toBe(false);
  });
});

describe('#799 — validateInboundWebhook: delivery-ID dedup (replay protection)', () => {
  it('passes first delivery through', async () => {
    const next = jest.fn();
    const { req, res } = makeReqRes({ deliveryId: 'unique-delivery-1' });
    await middleware(req, res, next);
    expect(mockCreate).toHaveBeenCalledWith({ deliveryId: 'unique-delivery-1' });
    expect(next).toHaveBeenCalled();
  });

  it('rejects a replayed delivery-ID with 409', async () => {
    const dupError = new Error('E11000');
    dupError.code = 11000;
    mockCreate.mockRejectedValueOnce(dupError);

    const { req, res } = makeReqRes({ deliveryId: 'replayed-delivery' });
    await middleware(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('DUPLICATE_DELIVERY');
  });

  it('still calls next if delivery-ID store has a non-dedup error (fault tolerance)', async () => {
    mockCreate.mockRejectedValueOnce(new Error('DB timeout'));
    const next = jest.fn();
    const { req, res } = makeReqRes({ deliveryId: 'some-delivery' });
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
