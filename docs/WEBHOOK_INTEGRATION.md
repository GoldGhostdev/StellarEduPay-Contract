# Webhook Notification System

StellarEduPay notifies external systems in real-time when payment events occur.

## Setup

### 1. Register a webhook URL

Register your HTTPS endpoint per school via the admin API:

```
POST /api/schools/:slug/webhooks
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "webhookUrl": "https://your-server.com/webhook"
}
```

Your school's HMAC signing secret is provisioned automatically when the school is created. Retrieve it from the admin dashboard to use in signature verification.

### 2. Receive events

Your endpoint receives `POST` requests with a JSON body:

```json
{
  "event": "payment.confirmed",
  "timestamp": "2026-03-27T10:30:00.000Z",
  "data": {
    "transactionHash": "abc123...",
    "studentId": "STU-001",
    "amount": 100.5,
    "assetCode": "XLM",
    "confirmedAt": "2026-03-27T10:30:00.000Z"
  }
}
```

## Events

| Event | Trigger |
|-------|---------|
| `payment.confirmed` | Payment verified and ledger-confirmed |
| `payment.pending` | Payment detected, awaiting confirmation |
| `payment.failed` | Payment failed on Stellar network |
| `payment.suspicious` | Flagged by fraud detection |

## Security: verifying the signature

Every delivery is signed with HMAC-SHA256 using your school's secret. Always verify the signature before processing the event.

### Headers sent on every delivery

| Header | Example | Purpose |
|--------|---------|---------|
| `X-StellarEduPay-Signature` | `sha256=a1b2c3...` | HMAC-SHA256 of the entire JSON body |
| `X-StellarEduPay-Timestamp` | `1711532400` | Unix timestamp (seconds) of delivery |
| `X-StellarEduPay-Delivery-ID` | `550e8400-...` | Unique delivery UUID for idempotency |

### Signature algorithm

The signature is computed over the **serialised JSON body** (the exact bytes you receive):

```
HMAC-SHA256(secret, JSON.stringify(body))
```

The header value is `sha256=<hex-digest>`.

### Verification recipe (Node.js)

```js
const crypto = require('crypto');

function verifyWebhook(rawBody, headers, secret) {
  // 1. Reject stale deliveries (replay protection — 5 min tolerance)
  const ts = parseInt(headers['x-stellaredupay-timestamp'], 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    return { valid: false, reason: 'timestamp out of tolerance' };
  }

  // 2. Verify HMAC — use constant-time comparison to prevent timing attacks
  const [, provided] = (headers['x-stellaredupay-signature'] || '').split('sha256=');
  if (!provided) return { valid: false, reason: 'missing signature' };

  const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) {
    return { valid: false, reason: 'signature length mismatch' };
  }
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  return { valid: true };
}
```

> **Important:** parse the raw request body as a `Buffer` or `string` — do not re-serialise a parsed JS object, as key ordering may differ and the signature will not match.

### Verification recipe (Python)

```python
import hashlib, hmac, time

def verify_webhook(raw_body: bytes, headers: dict, secret: str) -> bool:
    # Reject stale deliveries
    ts = int(headers.get('x-stellaredupay-timestamp', 0))
    if abs(time.time() - ts) > 300:
        return False

    provided = headers.get('x-stellaredupay-signature', '').removeprefix('sha256=')
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, provided)
```

## Replay protection

Use the `X-StellarEduPay-Delivery-ID` header as an idempotency key. Store the delivery IDs you have already processed and reject any request whose ID you have seen before:

```js
const processedIds = new Set(); // use Redis or a database for durability

app.post('/webhook', (req, res) => {
  const deliveryId = req.headers['x-stellaredupay-delivery-id'];

  const { valid } = verifyWebhook(req.rawBody, req.headers, WEBHOOK_SECRET);
  if (!valid) return res.status(401).end();

  if (processedIds.has(deliveryId)) {
    return res.status(200).json({ status: 'duplicate, ignored' });
  }
  processedIds.add(deliveryId);

  // … handle event …
  res.status(200).end();
});
```

## Acknowledge quickly

Respond with **HTTP 2xx** within **10 seconds**. If your processing takes longer, acknowledge first and handle the event asynchronously.

## Retry logic

Failed deliveries are retried up to **3 times** with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1st retry | 1 minute |
| 2nd retry | 5 minutes |
| 3rd retry | 15 minutes |

After all retries are exhausted the delivery is moved to the dead-letter queue and is visible to administrators via `GET /api/admin/webhooks/dlq`. An admin can re-trigger a failed delivery with `POST /api/admin/webhooks/dlq/:id/retry`.

---

## Multiple endpoints and per-event subscriptions (#865)

Each school can register **multiple webhook endpoints**, each subscribing to a different set of events.

```
POST /api/webhook-endpoints
Authorization: Bearer <school-token>
X-School-ID: SCH-1
Content-Type: application/json

{
  "url": "https://your-server.com/payments",
  "subscribedEvents": ["payment.confirmed", "payment.failed"],
  "description": "ERP integration"
}
```

Response includes the `secret` (shown **once** at creation — store it securely).

### Manage endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST`   | `/api/webhook-endpoints`        | Create endpoint |
| `GET`    | `/api/webhook-endpoints`        | List all endpoints for the school |
| `GET`    | `/api/webhook-endpoints/:id`    | Get single endpoint |
| `PUT`    | `/api/webhook-endpoints/:id`    | Update url / events / isActive |
| `DELETE` | `/api/webhook-endpoints/:id`    | Delete endpoint |

**Disabling an endpoint**: set `isActive: false` — it is silently skipped on all deliveries.

### Delivery history and replay

```
GET  /api/webhook-deliveries?endpointId=<id>&page=1&limit=20
POST /api/webhook-deliveries/:id/replay
```

Each delivery attempt is logged with status code, response body (truncated to 1 KB), duration, and error details.

---

## PII field controls (#867)

By default, webhook payloads are **minimal — no PII**. The fields `studentId` and `senderAddress` are excluded unless explicitly opted in.

### Default payload fields

```json
{
  "event": "payment.confirmed",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "data": {
    "txHash": "abc123",
    "amount": 100,
    "assetCode": "XLM",
    "status": "confirmed",
    "schoolId": "SCH-1",
    "confirmedAt": "2026-01-01T00:00:00.000Z",
    "referenceCode": "REF-001"
  }
}
```

### Opt-in to PII fields

Update the school's `webhookPayloadConfig` via `PUT /api/schools/:id`:

```json
{
  "webhookPayloadConfig": {
    "allowedFields": [
      "event", "txHash", "amount", "assetCode", "status", "schoolId",
      "confirmedAt", "referenceCode", "studentId", "senderAddress"
    ]
  }
}
```

**Available fields**: `event`, `txHash`, `transactionHash`, `amount`, `asset`, `assetCode`, `status`, `schoolId`, `ts`, `timestamp`, `correlationId`, `referenceCode`, `finalFee`, `feeValidationStatus`, `confirmedAt`, `ledgerSequence`, `reason`, `isSuspicious`, `originalTxHash`, `refundTxHash`, `refundedAt`, `studentId` *(PII)*, `senderAddress` *(PII)*

---

## SSRF mitigations (#866)

All webhook URLs are validated at **registration time and again at every send**:

- Only `https://` scheme is accepted.
- Hostnames resolving to RFC 1918, loopback (127.0.0.0/8, ::1), link-local (169.254.0.0/16, fe80::/10), CGNAT (100.64.0.0/10), and metadata ranges are blocked.
- IPv6 ULA (fc00::/7), IPv4-mapped private addresses (`::ffff:10.x.x.x`), and NAT64 prefixes are blocked.
- **Redirects are disabled** — a 3xx response from the endpoint is treated as a delivery failure (`SSRF_REDIRECT_BLOCKED`).
- Response bodies are capped at 64 KB.
- DNS is re-resolved immediately before each delivery (DNS-rebinding defence).
