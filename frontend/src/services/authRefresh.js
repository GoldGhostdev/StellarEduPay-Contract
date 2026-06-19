/**
 * Single-flight access-token refresh coordinator for the axios response
 * interceptor.
 *
 * On a 401 the original request is held while the access token is refreshed
 * exactly once, then replayed. Any other requests that 401 while that refresh is
 * in flight are queued and replayed together when it resolves — so a burst of
 * concurrent 401s triggers exactly one call to the refresh endpoint, never one
 * per request. If the refresh itself fails the queued requests are rejected and
 * the caller is sent to the login screen.
 *
 * The factory takes its side effects as dependencies so it can be unit-tested
 * without a live network or a browser:
 *   - refresh()          -> Promise   performs POST /auth/refresh (sets cookies)
 *   - retry(config)      -> Promise   replays the original request
 *   - redirectToLogin()  -> void      navigates to /login (only on refresh fail)
 *   - isAuthUrl(url)     -> boolean   true for auth endpoints (never refreshed)
 */
export function createRefreshHandler({ refresh, retry, redirectToLogin, isAuthUrl }) {
  let isRefreshing = false;
  // Requests parked while a refresh is in flight. Each entry resolves when the
  // refresh succeeds (replay) or rejects when it fails (give up).
  let waiters = [];

  function settleWaiters(error) {
    const pending = waiters;
    waiters = [];
    for (const { resolve, reject } of pending) {
      if (error) reject(error);
      else resolve();
    }
  }

  function waitForRefresh() {
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  return async function onRejected(error) {
    const original = error?.config;
    const status = error?.response?.status;

    // Only act on a retryable 401. Anything else (other status, no config, a
    // request we already retried, or an auth endpoint itself) passes through so
    // a failed refresh can't recurse into another refresh.
    if (status !== 401 || !original || original._retry || isAuthUrl(original.url || "")) {
      return Promise.reject(error);
    }

    original._retry = true;

    // A refresh is already running — park this request and replay it after.
    if (isRefreshing) {
      try {
        await waitForRefresh();
      } catch {
        // Refresh failed; surface the original 401 (the refresher already
        // handled redirecting to login).
        return Promise.reject(error);
      }
      return retry(original);
    }

    // This request owns the refresh.
    isRefreshing = true;
    try {
      await refresh();
      isRefreshing = false;
      settleWaiters(); // release everyone parked behind us
      return retry(original);
    } catch (refreshError) {
      isRefreshing = false;
      settleWaiters(refreshError); // reject everyone parked behind us
      redirectToLogin();
      return Promise.reject(refreshError);
    }
  };
}
