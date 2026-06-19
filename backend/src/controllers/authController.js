'use strict';

const crypto = require('crypto');

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // run anyway to avoid short-circuit timing leak
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Refresh token store (Redis when available, in-process Map otherwise) ──────

let _store; // lazy-initialised

function getStore() {
  if (_store) return _store;

  if (process.env.REDIS_HOST) {
    const Redis = require('ioredis');
    const client = new Redis({
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    _store = {
      async set(token, ttlSeconds) {
        await client.set(`refresh:${token}`, '1', 'EX', ttlSeconds);
      },
      async has(token) {
        return (await client.exists(`refresh:${token}`)) === 1;
      },
      async del(token) {
        await client.del(`refresh:${token}`);
      },
    };
  } else {
    // In-process fallback — counters reset on restart (acceptable for single-process/dev)
    const map = new Map();
    _store = {
      async set(token, ttlSeconds) {
        map.set(token, Date.now() + ttlSeconds * 1000);
      },
      async has(token) {
        const exp = map.get(token);
        if (!exp) return false;
        if (Date.now() > exp) { map.delete(token); return false; }
        return true;
      },
      async del(token) {
        map.delete(token);
      },
    };
  }

  return _store;
}

// Exposed for testing
function _resetStore() { _store = null; }

// ── Cookies ───────────────────────────────────────────────────────────────────
// The access token rides in the `admin_token` cookie (sent on every API call),
// while the refresh token rides in `admin_refresh_token`, scoped to the auth
// routes so it is never transmitted to ordinary endpoints. Both are HttpOnly so
// JS — and therefore an XSS payload — can never read them.

const ACCESS_COOKIE = 'admin_token';
const REFRESH_COOKIE = 'admin_refresh_token';
const REFRESH_COOKIE_PATH = '/api/auth';

function accessCookieOptions(ttlSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ttlSeconds * 1000,
    path: '/',
  };
}

function refreshCookieOptions(ttlSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ttlSeconds * 1000,
    path: REFRESH_COOKIE_PATH,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTTL(envVar, defaultSeconds) {
  const val = process.env[envVar];
  if (!val) return defaultSeconds;
  // Accept plain seconds or strings like "8h", "30d"
  const match = val.match(/^(\d+)([smhd]?)$/);
  if (!match) return defaultSeconds;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, '': 1 };
  return n * (multipliers[unit] ?? 1);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 * Returns { token, expiresIn, refreshToken, refreshExpiresIn }
 */
async function handleLogin(req, res) {
  const { username, password } = req.body || {};

  const expectedUsername = process.env.ADMIN_USERNAME;
  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedUsername || !expectedPassword) {
    return res.status(500).json({
      error: 'Server misconfiguration: ADMIN_USERNAME or ADMIN_PASSWORD is not set.',
      code: 'AUTH_MISCONFIGURED',
    });
  }

  if (
    !username ||
    !password ||
    !safeEqual(username, expectedUsername) ||
    !safeEqual(password, expectedPassword)
  ) {
    return res.status(401).json({
      error: 'Invalid credentials.',
      code: 'INVALID_CREDENTIALS',
    });
  }

  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;

  const accessTTL = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);   // default 8h
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400); // default 30d

  const token = jwt.sign({ role: 'admin', username }, secret, { expiresIn: accessTTL });

  const refreshToken = crypto.randomBytes(40).toString('hex');

  // Store refresh token (non-blocking — fire and forget; failure means token won't be usable)
  getStore().set(refreshToken, refreshTTL).catch(() => {});

  res.cookie(ACCESS_COOKIE, token, accessCookieOptions(accessTTL));
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshTTL));

  // refreshToken is still returned in the body for non-browser API clients that
  // cannot use cookies; browser clients rely on the HttpOnly cookie above.
  return res.json({
    isAdmin: true,
    expiresIn: accessTTL,
    refreshToken,
    refreshExpiresIn: refreshTTL,
  });
}

/**
 * POST /api/auth/refresh
 * Token source: the HttpOnly `admin_refresh_token` cookie (browser flow), with
 * a `{ refreshToken }` body fallback for non-browser API clients.
 *
 * Refreshes the access token AND rotates the refresh token: the presented token
 * is invalidated and a fresh one issued, so a leaked refresh token is usable at
 * most once. Sets new `admin_token` and `admin_refresh_token` cookies and also
 * returns the new tokens in the body for API clients.
 *
 * Returns { token, expiresIn, refreshToken, refreshExpiresIn }.
 */
async function handleRefresh(req, res) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || (req.body && req.body.refreshToken);

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required.', code: 'MISSING_REFRESH_TOKEN' });
  }

  const store = getStore();
  const valid = await store.has(refreshToken);
  if (!valid) {
    // Clear the stale cookie so the browser stops presenting a dead token.
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return res.status(401).json({ error: 'Invalid or expired refresh token.', code: 'INVALID_REFRESH_TOKEN' });
  }

  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;
  const accessTTL = parseTTL('JWT_ACCESS_TOKEN_TTL', 8 * 3600);
  const refreshTTL = parseTTL('JWT_REFRESH_TOKEN_TTL', 30 * 86400);

  // Rotate: mint a new refresh token, then invalidate the one just used. Storing
  // the new token before deleting the old avoids a window with neither valid.
  const newRefreshToken = crypto.randomBytes(40).toString('hex');
  await store.set(newRefreshToken, refreshTTL);
  await store.del(refreshToken);

  const token = jwt.sign({ role: 'admin' }, secret, { expiresIn: accessTTL });

  res.cookie(ACCESS_COOKIE, token, accessCookieOptions(accessTTL));
  res.cookie(REFRESH_COOKIE, newRefreshToken, refreshCookieOptions(refreshTTL));

  return res.json({
    token,
    expiresIn: accessTTL,
    refreshToken: newRefreshToken,
    refreshExpiresIn: refreshTTL,
  });
}

/**
 * POST /api/auth/logout
 * Body: { refreshToken }
 * Invalidates the refresh token.
 */
async function handleLogout(req, res) {
  const refreshToken = req.cookies?.[REFRESH_COOKIE] || (req.body && req.body.refreshToken);

  if (refreshToken) {
    await getStore().del(refreshToken);
  }

  res.clearCookie(ACCESS_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: REFRESH_COOKIE_PATH });
  return res.json({ message: 'Logged out.' });
}

/**
 * GET /api/auth/me
 * Returns { isAdmin: true } when the request carries a valid admin cookie/token.
 * Used by the frontend to check auth state on page load.
 */
function handleMe(req, res) {
  return res.json({ isAdmin: true });
}

module.exports = { handleLogin, handleRefresh, handleLogout, handleMe, _resetStore };
