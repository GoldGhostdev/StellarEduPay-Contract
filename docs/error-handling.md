# Error Handling Policy

## Process-level handlers

Installed in `src/errorHandling.js` and wired once from `src/app.js`.

### `unhandledRejection`
- **Action**: log structured context, then **exit(1)**.
- Rationale: an unhandled rejection is a programming error or failed async operation with no recovery path. Continuing risks data corruption and inconsistent state.

### `uncaughtException`
- **Action**: log structured context, then **exit(1)** immediately.
- Rationale: after an uncaught exception the process is in an untrusted state; continuing can produce silent data corruption.

## Promise rejection rules

- **Never use** `.catch(() => {})` — silent swallowing hides real failures.
- **Non-critical fire-and-forget** (e.g. auth sidecart writes, cleanup on shutdown): use `.catch(err => logger.debug(...))` so failures are observable via logs but do not crash the request flow.
- **Critical operations** (DB writes, payment records, token store): surface via Express error handlers or structured `logger.error(...)`; do not suppress.

## Crash vs. continue decision tree

| Situation | Action |
|---|---|
| Unhandled promise rejection anywhere in process | Log + exit(1) |
| Uncaught exception anywhere in process | Log + exit(1) |
| Fire-and-forget cleanup (Redis release, session update) | Log debug, continue |
| Request handler rejects | Pass to `next(err)` → global error handler |

## Graceful shutdown

`SIGTERM` / `SIGINT` trigger the existing `shutdown()` flow in `src/app.js` (drain workers, close queues, disconnect Mongo, then `process.exit(0)`).
