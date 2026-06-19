/**
 * Tests for the single-flight access-token refresh coordinator used by the
 * axios response interceptor.
 *
 * Maps directly to the acceptance criteria:
 *   - access-token expiry transparently refreshes and replays (no redirect)
 *   - concurrent 401s trigger exactly one refresh and replay all requests
 *   - a failed refresh redirects to login and rejects the parked requests
 */

import { createRefreshHandler } from '../authRefresh';

// A promise whose resolution is controlled by the test, to interleave the
// concurrent-401 case deterministically.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function build(overrides = {}) {
  const refresh = overrides.refresh || jest.fn(() => Promise.resolve());
  const retry = overrides.retry || jest.fn((config) => Promise.resolve({ replayed: config.url }));
  const redirectToLogin = overrides.redirectToLogin || jest.fn();
  const isAuthUrl = overrides.isAuthUrl || ((url) => url.includes('/auth/'));
  const handler = createRefreshHandler({ refresh, retry, redirectToLogin, isAuthUrl });
  return { handler, refresh, retry, redirectToLogin, isAuthUrl };
}

function err401(url = '/students', extra = {}) {
  return { config: { url, ...extra }, response: { status: 401 } };
}

describe('createRefreshHandler', () => {
  describe('transparent refresh (single request)', () => {
    it('refreshes once and replays the original request without redirecting', async () => {
      const { handler, refresh, retry, redirectToLogin } = build();

      const result = await handler(err401('/students'));

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(retry.mock.calls[0][0].url).toBe('/students');
      expect(redirectToLogin).not.toHaveBeenCalled();
      expect(result).toEqual({ replayed: '/students' });
    });

    it('marks the request retried so a second 401 is not refreshed again', async () => {
      const { handler, refresh } = build({
        // The replay itself comes back 401 → must NOT trigger another refresh.
        retry: jest.fn((config) => Promise.reject(err401(config.url, { _retry: config._retry }))),
      });

      await expect(handler(err401('/students'))).rejects.toBeDefined();
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrent 401s', () => {
    it('triggers exactly one refresh and replays every parked request', async () => {
      const gate = deferred();
      const refresh = jest.fn(() => gate.promise);
      const { handler, retry, redirectToLogin } = build({ refresh });

      // Three requests fail with 401 at (nearly) the same time.
      const p1 = handler(err401('/students'));
      const p2 = handler(err401('/payments'));
      const p3 = handler(err401('/fees'));

      // Only the first owns the refresh; the rest are parked behind it.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();

      gate.resolve();
      const results = await Promise.all([p1, p2, p3]);

      expect(refresh).toHaveBeenCalledTimes(1); // still exactly one
      expect(retry).toHaveBeenCalledTimes(3);   // all three replayed
      const replayedUrls = results.map((r) => r.replayed).sort();
      expect(replayedUrls).toEqual(['/fees', '/payments', '/students']);
      expect(redirectToLogin).not.toHaveBeenCalled();
    });

    it('allows a fresh refresh on a later 401 after the first cycle completes', async () => {
      const { handler, refresh } = build();

      await handler(err401('/students'));
      await handler(err401('/payments'));

      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });

  describe('failed refresh', () => {
    it('redirects to login once and rejects the original and parked requests', async () => {
      const gate = deferred();
      const refresh = jest.fn(() => gate.promise);
      const { handler, retry, redirectToLogin } = build({ refresh });

      const p1 = handler(err401('/students'));
      const p2 = handler(err401('/payments'));

      gate.reject(new Error('refresh failed'));

      await expect(p1).rejects.toBeDefined();
      await expect(p2).rejects.toBeDefined();

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(retry).not.toHaveBeenCalled();
      expect(redirectToLogin).toHaveBeenCalledTimes(1);
    });
  });

  describe('pass-through (no refresh attempted)', () => {
    it('ignores non-401 errors', async () => {
      const { handler, refresh, redirectToLogin } = build();
      const error = { config: { url: '/students' }, response: { status: 500 } };
      await expect(handler(error)).rejects.toBe(error);
      expect(refresh).not.toHaveBeenCalled();
      expect(redirectToLogin).not.toHaveBeenCalled();
    });

    it('ignores network errors that carry no response', async () => {
      const { handler, refresh } = build();
      const error = { config: { url: '/students' }, message: 'timeout' };
      await expect(handler(error)).rejects.toBe(error);
      expect(refresh).not.toHaveBeenCalled();
    });

    it('does not try to refresh when the refresh endpoint itself 401s', async () => {
      const { handler, refresh, redirectToLogin } = build();
      const error = err401('/auth/refresh');
      await expect(handler(error)).rejects.toBe(error);
      expect(refresh).not.toHaveBeenCalled();
      expect(redirectToLogin).not.toHaveBeenCalled();
    });

    it('does not refresh an already-retried request', async () => {
      const { handler, refresh } = build();
      const error = err401('/students', { _retry: true });
      await expect(handler(error)).rejects.toBe(error);
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});
