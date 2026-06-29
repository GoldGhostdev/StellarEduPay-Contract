"use strict";

const mongoose = require("mongoose");
const { transactionManager } = require("./transactionManager");
const { logger } = require("../utils/logger");
const Student = require("../models/studentModel");
const Payment = require("../models/paymentModel");
const PaymentIntent = require("../models/paymentIntentModel");
const { sendPaymentWebhook } = require("./webhookService");
const { deriveIdempotencyKey } = require("../utils/idempotencyKey");
const idempotencyStore = require("./idempotencyStore");

// Scope under which the processor namespaces its idempotency keys. Distinct
// from any HTTP middleware scope (request path) so the two layers never collide
// in the shared persistent store — while still deriving keys through the same
// canonical function, so they cannot disagree about what a given client key
// means.
const PROCESSOR_SCOPE = "payment-processor";

// Reconstruct a PaymentProcessingResult from a persisted JSON body so replayed
// results behave like freshly produced ones (`.success`, `.toJSON()`).
function rehydrateResult(body) {
  if (!body) return null;
  const result = new PaymentProcessingResult(
    Boolean(body.success),
    body.data || {},
    body.error || null
  );
  if (body.timestamp) result.timestamp = body.timestamp;
  return result;
}

// ── Idempotency Cache ─────────────────────────────────────────────────────────
// Demoted to a pure read-through cache of the persistent `idempotencyStore`.
// The persistent store (Mongo, optionally fronted by Redis) is the single
// source of truth and survives restarts / spans replicas; this in-process Map
// is only an L1 to skip a store round-trip within the TTL window.
class IdempotencyCache {
  constructor(ttlMs = 60000, store = idempotencyStore) {
    this.l1 = new Map();
    this.ttlMs = ttlMs;
    this.store = store;
    this.scope = PROCESSOR_SCOPE;
  }

  _l1Get(canonicalKey) {
    const entry = this.l1.get(canonicalKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.l1.delete(canonicalKey);
      return null;
    }
    return entry.result;
  }

  // Returns a cached PaymentProcessingResult or null. The persistent store is
  // authoritative; the L1 is consulted first only as an optimization.
  async get(rawKey) {
    const canonicalKey = deriveIdempotencyKey(rawKey, this.scope);
    if (!canonicalKey) return null;

    const local = this._l1Get(canonicalKey);
    if (local) return local;

    const record = await this.store.get(canonicalKey);
    if (!record) return null;

    const result = rehydrateResult(record.responseBody);
    this.l1.set(canonicalKey, { result, expiresAt: Date.now() + this.ttlMs });
    return result;
  }

  async set(rawKey, result) {
    const canonicalKey = deriveIdempotencyKey(rawKey, this.scope);
    if (!canonicalKey) return;

    this.l1.set(canonicalKey, { result, expiresAt: Date.now() + this.ttlMs });
    if (this.l1.size % 100 === 0) this.cleanup();

    await this.store.set(canonicalKey, {
      scope: this.scope,
      responseStatus: 200,
      responseBody: result.toJSON ? result.toJSON() : result,
    });
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.l1.entries()) {
      if (now > entry.expiresAt) this.l1.delete(key);
    }
  }
}

// ── Rate Limiter ───────────────────────────────────────────────────────────────
class RateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests || 100;
    this.windowMs = options.windowMs || 1000;
    this.requests = new Map();
  }

  isAllowed(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    let info = this.requests.get(key);

    if (!info || info.windowStart < windowStart) {
      info = { windowStart: now, count: 0 };
    }

    info.count++;
    this.requests.set(key, info);

    if (info.count > this.maxRequests) {
      return {
        allowed: false,
        retryAfterMs: this.windowMs - (now - info.windowStart),
      };
    }

    return { allowed: true, remaining: this.maxRequests - info.count };
  }

  cleanup() {
    const windowStart = Date.now() - this.windowMs * 2;
    for (const [key, info] of this.requests.entries()) {
      if (info.windowStart < windowStart) this.requests.delete(key);
    }
  }
}

// ── Concurrency Strategies ────────────────────────────────────────────────────
const CONCURRENCY_STRATEGY = {
  OPTIMISTIC: "optimistic",
  PESSIMISTIC: "pessimistic",
  SERIALIZABLE: "serializable",
};

// ── Payment Result ───────────────────────────────────────────────────────────
class PaymentProcessingResult {
  constructor(success, data = {}, error = null) {
    this.success = success;
    this.data = data;
    this.error = error;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      success: this.success,
      data: this.data,
      error: this.error
        ? { message: this.error.message, code: this.error.code }
        : null,
      timestamp: this.timestamp,
    };
  }
}

// ── Main Processor ───────────────────────────────────────────────────────────
class ConcurrentPaymentProcessor {
  constructor(options = {}) {
    this.idempotencyCache = new IdempotencyCache(
      options.idempotencyTtlMs || 60000
    );
    this.rateLimiter = new RateLimiter({
      maxRequests: options.maxRequestsPerSecond || 100,
      windowMs: 1000,
    });
    this.defaultLockStrategy =
      options.lockStrategy || CONCURRENCY_STRATEGY.OPTIMISTIC;
    this.lockTimeoutMs = options.lockTimeoutMs || 30000;
    this.maxRetries = options.maxRetries || 3;
    this.maxQueueDepth = options.maxQueueDepth || 1000;
    this.activeCount = 0;

    // ── Batch / backpressure tuning (issue #851) ──────────────────────────────
    // Default concurrency for processBatch when the caller doesn't override it.
    this.batchConcurrencyLimit = options.batchConcurrencyLimit || 10;
    // When Horizon (via the rate-limited client) signals saturation, hold new
    // dispatches rather than piling on and tripping the rate limiter. Bounded so
    // a wedged signal can't stall a batch forever. Off by default so unit tests
    // that construct a bare processor don't pull in the Horizon client; the
    // production singleton below opts in.
    this.backpressureEnabled = options.backpressureEnabled === true;
    this.backpressureDelayMs = options.backpressureDelayMs || 100;
    this.maxBackpressureWaitMs = options.maxBackpressureWaitMs || 5000;
    // Injectable for tests; defaults to the shared rate-limited client's readiness.
    this.isHorizonReady =
      options.isHorizonReady ||
      (() => {
        try {
          return require("./stellarRateLimitedClient").getClient().isReady();
        } catch (_) {
          // Client not initialized (e.g. Redis-less test env) — assume ready.
          return true;
        }
      });
  }

  // ── Process Payment ───────────────────────────────────────────────────────
  async processPayment(paymentData, options = {}) {
    const {
      idempotencyKey,
      lockStrategy = this.defaultLockStrategy,
      studentId,
      amount,
      txHash,
    } = options;

    // Queue depth check
    if (this.activeCount >= this.maxQueueDepth) {
      return new PaymentProcessingResult(
        false,
        {},
        { message: "Queue is full", code: "QUEUE_FULL" }
      );
    }

    // Idempotency check — persistent store is the source of truth, so a replay
    // is recognized even after a restart or on another replica.
    if (idempotencyKey) {
      const cached = await this.idempotencyCache.get(idempotencyKey);
      if (cached) {
        logger.info("[PaymentProcessor] Returning persisted idempotent result", {
          idempotencyKey,
        });
        return cached;
      }
    }

    // Rate limit check
    const rateLimitResult = this.rateLimiter.isAllowed(`payment:${studentId}`);
    if (!rateLimitResult.allowed) {
      return new PaymentProcessingResult(
        false,
        {},
        {
          message: "Rate limit exceeded",
          code: "RATE_LIMIT_EXCEEDED",
          retryAfterMs: rateLimitResult.retryAfterMs,
        }
      );
    }

    this.activeCount++;
    try {
      // Duplicate transaction
      const existingPayment = await Payment.findOne({ txHash, deletedAt: null });
      if (existingPayment) {
        logger.warn("[PaymentProcessor] Duplicate transaction", { txHash });
        const result = new PaymentProcessingResult(true, {
          duplicate: true,
          existingPaymentId: existingPayment._id,
        });
        if (idempotencyKey) await this.idempotencyCache.set(idempotencyKey, result);
        return result;
      }

      // Choose lock strategy
      let processingResult;
      switch (lockStrategy) {
        case CONCURRENCY_STRATEGY.PESSIMISTIC:
          processingResult = await this.processWithPessimisticLock(
            studentId,
            amount,
            txHash,
            paymentData
          );
          break;
        case CONCURRENCY_STRATEGY.SERIALIZABLE:
          processingResult = await this.processWithSerializableTransaction(
            studentId,
            amount,
            txHash,
            paymentData
          );
          break;
        case CONCURRENCY_STRATEGY.OPTIMISTIC:
        default:
          processingResult = await this.processWithOptimisticLock(
            studentId,
            amount,
            txHash,
            paymentData
          );
      }

      // Cache success
      if (idempotencyKey && processingResult.success)
        await this.idempotencyCache.set(idempotencyKey, processingResult);

      // Trigger webhook (non-blocking)
      this.triggerWebhook(
        studentId,
        amount,
        txHash,
        paymentData,
        processingResult
      );

      return processingResult;
    } catch (err) {
      return new PaymentProcessingResult(
        false,
        {},
        { message: err.message, code: "PROCESSING_ERROR" }
      );
    } finally {
      this.activeCount--;
    }
  }

  // ── Webhook trigger ───────────────────────────────────────────────────────
  async triggerWebhook(
    studentId,
    amount,
    txHash,
    paymentData,
    processingResult
  ) {
    if (processingResult.success && process.env.PAYMENT_WEBHOOK_URL) {
      try {
        const { payment } = processingResult.data;
        if (payment) {
          sendPaymentWebhook(process.env.PAYMENT_WEBHOOK_URL, {
            paymentId: payment._id,
            studentId,
            amount,
            currency: paymentData.currency || "USDC",
            status: "confirmed",
            txHash,
            timestamp: new Date().toISOString(),
          });
          logger.info("[Webhook] Triggered", { paymentId: payment._id });
        }
      } catch (err) {
        logger.error("[Webhook] Failed to trigger", {
          error: err.message,
          studentId,
          txHash,
        });
      }
    }
  }

  // ── Optimistic Lock ──────────────────────────────────────────────────────
  async processWithOptimisticLock(studentId, amount, txHash, paymentData) {
    let attempt = 0;

    while (attempt < this.maxRetries) {
      try {
        const student = await Student.findOne({ studentId });
        if (!student)
          return new PaymentProcessingResult(
            false,
            {},
            {
              message: `Student not found: ${studentId}`,
              code: "STUDENT_NOT_FOUND",
            }
          );

        const currentTotal = student.totalPaid || 0;
        const newTotal = currentTotal + amount;
        
        // Reconciliation Invariant Check
        const allocationAmount = newTotal - currentTotal;
        if (allocationAmount !== amount) {
          throw new Error(`Reconciliation invariant failed: allocation (${allocationAmount}) != payment amount (${amount})`);
        }
        
        const newRemainingBalance = Math.max(0, student.feeAmount - newTotal);
        const isFeePaid = newTotal >= student.feeAmount;

        const updatedStudent = await Student.findOneAndUpdate(
          { studentId, totalPaid: currentTotal },
          {
            $set: {
              totalPaid: newTotal,
              remainingBalance: newRemainingBalance,
              feePaid: isFeePaid,
              lastPaymentAt: new Date(),
              lastPaymentHash: txHash,
            },
          },
          { new: true }
        );

        if (!updatedStudent) {
          attempt++;
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * Math.pow(2, attempt))
          );
          logger.warn("[PaymentProcessor] Optimistic lock conflict", {
            studentId,
            attempt,
          });
          continue;
        }

        const payment = await Payment.create({
          studentId,
          txHash,
          amount,
          feeAmount: student.feeAmount,
          feeValidationStatus: isFeePaid
            ? "valid"
            : amount < student.feeAmount
            ? "underpaid"
            : "overpaid",
          status: "confirmed",
          ...paymentData,
        });

        return new PaymentProcessingResult(true, {
          student,
          payment,
          newTotalPaid: newTotal,
          remainingBalance: newRemainingBalance,
          feePaid: isFeePaid,
        });
      } catch (error) {
        if (this.isRetryableError(error)) {
          attempt++;
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * Math.pow(2, attempt))
          );
          logger.warn("[PaymentProcessor] Retrying after error", {
            studentId,
            attempt,
            error: error.message,
          });
          continue;
        }
        throw error;
      }
    }

    return new PaymentProcessingResult(
      false,
      {},
      {
        message: `Failed after ${this.maxRetries} attempts`,
        code: "MAX_RETRIES_EXCEEDED",
      }
    );
  }

  // ── Pessimistic Lock ─────────────────────────────────────────────────────
  async processWithPessimisticLock(studentId, amount, txHash, paymentData) {
    return await transactionManager.withPessimisticLock(
      async () => {
        return await transactionManager.withTransaction(async (session) => {
          const student = await Student.findOne({ studentId }).session(session);
          if (!student) throw new Error(`Student not found: ${studentId}`);

          const currentTotal = student.totalPaid || 0;
          const newTotal = currentTotal + amount;
          
          // Reconciliation Invariant Check
          const allocationAmount = newTotal - currentTotal;
          if (allocationAmount !== amount) {
            throw new Error(`Reconciliation invariant failed: allocation (${allocationAmount}) != payment amount (${amount})`);
          }
          
          const newRemainingBalance = Math.max(0, student.feeAmount - newTotal);
          const isFeePaid = newTotal >= student.feeAmount;

          student.totalPaid = newTotal;
          student.remainingBalance = newRemainingBalance;
          student.feePaid = isFeePaid;
          student.lastPaymentAt = new Date();
          student.lastPaymentHash = txHash;
          await student.save({ session });

          const payment = await Payment.create(
            [
              {
                studentId,
                txHash,
                amount,
                feeAmount: student.feeAmount,
                feeValidationStatus: isFeePaid
                  ? "valid"
                  : amount < student.feeAmount
                  ? "underpaid"
                  : "overpaid",
                status: "confirmed",
                ...paymentData,
              },
            ],
            { session }
          );

          return new PaymentProcessingResult(true, {
            student,
            payment: payment[0],
            newTotalPaid: newTotal,
            remainingBalance: newRemainingBalance,
            feePaid: isFeePaid,
          });
        });
      },
      {
        entityType: "Student",
        entityId: studentId,
        lockDurationMs: this.lockTimeoutMs,
      }
    );
  }

  // ── Serializable Transaction ─────────────────────────────────────────────
  async processWithSerializableTransaction(
    studentId,
    amount,
    txHash,
    paymentData
  ) {
    return await transactionManager.withTransaction(async (session) => {
      const student = await Student.findOne({ studentId }).session(session);
      if (!student) throw new Error(`Student not found: ${studentId}`);

      const currentTotal = student.totalPaid || 0;
      const newTotal = currentTotal + amount;
      
      // Reconciliation Invariant Check
      const allocationAmount = newTotal - currentTotal;
      if (allocationAmount !== amount) {
        throw new Error(`Reconciliation invariant failed: allocation (${allocationAmount}) != payment amount (${amount})`);
      }
      
      const newRemainingBalance = Math.max(0, student.feeAmount - newTotal);
      const isFeePaid = newTotal >= student.feeAmount;

      const updateResult = await Student.updateOne(
        { studentId, totalPaid: currentTotal },
        {
          $set: {
            totalPaid: newTotal,
            remainingBalance: newRemainingBalance,
            feePaid: isFeePaid,
            lastPaymentAt: new Date(),
            lastPaymentHash: txHash,
          },
        },
        { session }
      );
      if (updateResult.matchedCount === 0)
        throw new Error(
          "Concurrent modification detected - transaction aborted"
        );

      const payment = await Payment.create(
        [
          {
            studentId,
            txHash,
            amount,
            feeAmount: student.feeAmount,
            feeValidationStatus: isFeePaid
              ? "valid"
              : amount < student.feeAmount
              ? "underpaid"
              : "overpaid",
            status: "confirmed",
            ...paymentData,
          },
        ],
        { session }
      );

      return new PaymentProcessingResult(true, {
        student,
        payment: payment[0],
        newTotalPaid: newTotal,
        remainingBalance: newRemainingBalance,
        feePaid: isFeePaid,
      });
    });
  }

  // ── Retryable Error Check ────────────────────────────────────────────────
  isRetryableError(error) {
    const retryablePatterns = [
      "TransientTransactionError",
      "WriteConflict",
      "LockTimeout",
      "WriteConflict:",
    ];
    return (
      error.hasErrorLabel?.("TransientTransactionError") ||
      error.code === 112 ||
      error.code === 189 ||
      retryablePatterns.some((p) => error.message?.includes(p))
    );
  }

  // ── Backpressure ─────────────────────────────────────────────────────────
  // Hold until the Horizon-facing client reports it is not saturated, or the
  // bounded wait elapses (so a stuck signal can never deadlock a batch).
  async _awaitHorizonCapacity(maxWaitMs) {
    if (!this.backpressureEnabled) return;
    let waited = 0;
    while (waited < maxWaitMs) {
      let ready = true;
      try {
        ready = this.isHorizonReady();
      } catch (_) {
        ready = true;
      }
      if (ready) return;
      logger.warn("[PaymentProcessor] Horizon saturated — applying backpressure", {
        waitedMs: waited,
      });
      await new Promise((r) => setTimeout(r, this.backpressureDelayMs));
      waited += this.backpressureDelayMs;
    }
  }

  // ── Batch Processing ─────────────────────────────────────────────────────
  // Streaming worker pool: a fixed number of workers each pull the next item as
  // soon as they finish, so one slow payment never stalls a whole chunk.
  // Per-item failures are isolated into structured results — a single bad tx
  // never aborts the batch — and backpressure is applied against Horizon
  // saturation between dispatches. Outcomes are exported as metrics.
  async processBatch(payments, options = {}) {
    const items = Array.isArray(payments) ? payments : [];
    const concurrencyLimit = Math.max(
      1,
      options.concurrencyLimit || this.batchConcurrencyLimit
    );
    const queueFullRetryDelayMs =
      options.queueFullRetryDelayMs !== undefined
        ? options.queueFullRetryDelayMs
        : 500;
    const maxBackpressureWaitMs =
      options.maxBackpressureWaitMs !== undefined
        ? options.maxBackpressureWaitMs
        : this.maxBackpressureWaitMs;

    const startedAt = Date.now();
    const results = new Array(items.length);

    const processOne = async (payment, index) => {
      // Backpressure: yield to Horizon if it is saturated before dispatching.
      await this._awaitHorizonCapacity(maxBackpressureWaitMs);

      let result = await this.processPayment(payment, options);
      // QUEUE_FULL is local saturation — retry the same item after a delay
      // rather than counting it as a failure.
      while (result && result.error && result.error.code === "QUEUE_FULL") {
        logger.warn("[PaymentProcessor] Queue full, retrying after delay", {
          index,
          retryDelayMs: queueFullRetryDelayMs,
        });
        await new Promise((resolve) =>
          setTimeout(resolve, queueFullRetryDelayMs)
        );
        await this._awaitHorizonCapacity(maxBackpressureWaitMs);
        result = await this.processPayment(payment, options);
      }
      return result;
    };

    // Fixed pool of workers pulling from a shared cursor. A thrown error in one
    // item is caught and recorded — it never rejects the pool or aborts peers.
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          const value = await processOne(items[index], index);
          // `success` reflects whether the call completed without throwing
          // (Promise-level). `itemSuccess` is the business outcome — callers
          // inspect it (or `data.success`) for per-item detail.
          results[index] = {
            success: true,
            index,
            itemSuccess: !!(value && value.success),
            error:
              value && !value.success && value.error
                ? value.error.message
                : null,
            code: value && !value.success && value.error ? value.error.code : null,
            data: value,
          };
        } catch (err) {
          results[index] = {
            success: false,
            index,
            itemSuccess: false,
            error: err.message,
          };
        }
      }
    };

    const poolSize = Math.min(concurrencyLimit, items.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    // Promise-level counts (backward compatible): fulfilled vs thrown.
    const successful = results.filter((r) => r && r.success).length;
    const failed = results.length - successful;
    // Business-level counts: payments that actually processed vs not.
    const itemsSucceeded = results.filter((r) => r && r.itemSuccess).length;
    const itemsFailed = results.length - itemsSucceeded;

    // ── Batch metrics ──────────────────────────────────────────────────────
    try {
      const {
        paymentBatchTotal,
        paymentBatchItemsTotal,
        paymentBatchDurationSeconds,
      } = require("../metrics");
      paymentBatchTotal.inc();
      if (itemsSucceeded) paymentBatchItemsTotal.inc({ outcome: "success" }, itemsSucceeded);
      if (itemsFailed) paymentBatchItemsTotal.inc({ outcome: "failed" }, itemsFailed);
      paymentBatchDurationSeconds.observe((Date.now() - startedAt) / 1000);
    } catch (_) {
      // Metrics module not available — batch result is unaffected.
    }

    return {
      total: items.length,
      successful,
      failed,
      itemsSucceeded,
      itemsFailed,
      durationMs: Date.now() - startedAt,
      results,
    };
  }

  // ── Stats ───────────────────────────────────────────────────────────────
  getStats() {
    return {
      idempotencyCacheSize: this.idempotencyCache.l1.size,
      rateLimiterStats: { trackedKeys: this.rateLimiter.requests.size },
      transactionManagerStats: {
        activeTransactions: transactionManager.getActiveTransactionCount(),
      },
      queueDepth: this.activeCount,
      maxQueueDepth: this.maxQueueDepth,
    };
  }
}

const config = require("../config");

// ── Singleton Instance ─────────────────────────────────────────────────────
const concurrentPaymentProcessor = new ConcurrentPaymentProcessor({
  idempotencyTtlMs: 60000,
  maxRequestsPerSecond: 100,
  lockStrategy: CONCURRENCY_STRATEGY.PESSIMISTIC,
  lockTimeoutMs: 30000,
  maxRetries: 3,
  maxQueueDepth: config.MAX_QUEUE_DEPTH,
  // The live processor applies Horizon backpressure during batch processing.
  backpressureEnabled: true,
});

module.exports = {
  concurrentPaymentProcessor,
  ConcurrentPaymentProcessor,
  PaymentProcessingResult,
  IdempotencyCache,
  RateLimiter,
  CONCURRENCY_STRATEGY,
};
