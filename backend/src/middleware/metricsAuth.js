'use strict';

// Constant-time string comparison to prevent timing-based token enumeration.
const { timingSafeEqual } = require('crypto');
const rateLimit = require('express-rate-limit');

// Minimum token entropy: 32 hex chars = 128-bit key; reject obviously weak tokens.
const MIN_TOKEN_LENGTH = 32;

// Dedicated rate-limiter for /metrics — separate from the main API limiter so
// Prometheus scrapes are not throttled by normal API traffic and vice-versa.
// Abuse of the unauthenticated-fast-path is bounded to 60 attempts/minute.
const metricsRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests to metrics endpoint.', code: 'RATE_LIMIT_EXCEEDED' },
});

function safeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function metricsAuth(req, res, next) {
  const token = process.env.METRICS_TOKEN;
  if (!token) {
    return res.status(500).set('Content-Type', 'text/plain').send(
      '# METRICS_TOKEN is not configured — metrics endpoint is disabled.\n'
    );
  }

  if (token.length < MIN_TOKEN_LENGTH) {
    return res.status(500).set('Content-Type', 'text/plain').send(
      `# METRICS_TOKEN is too short (min ${MIN_TOKEN_LENGTH} chars) — metrics endpoint is disabled.\n`
    );
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.set('WWW-Authenticate', 'Bearer realm="metrics"');
    return res.status(401).set('Content-Type', 'text/plain').send(
      '# Unauthorized: provide Authorization: Bearer <METRICS_TOKEN>\n'
    );
  }

  const provided = authHeader.slice(7);
  if (!safeCompare(provided, token)) {
    return res.status(403).set('Content-Type', 'text/plain').send(
      '# Forbidden: invalid metrics token.\n'
    );
  }

  next();
}

module.exports = { metricsAuth, metricsRateLimiter };
