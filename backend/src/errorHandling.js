'use strict';

/**
 * Process-level error handling — installed exactly once from src/app.js.
 *
 * Policy (see docs/error-handling.md):
 *  unhandledRejection  → log + exit(1) after draining, then process.exit(1).
 *  uncaughtException   → log + exit(1) immediately (state is untrusted).
 */

const logger = require('./utils/logger');

function setupEnforceConsoleErrorLogging() {
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection', {
      reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason),
      promise: String(promise),
    });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — process is in an untrusted state', {
      error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
    });
    process.exit(1);
  });
}

module.exports = { setupEnforceConsoleErrorLogging };
