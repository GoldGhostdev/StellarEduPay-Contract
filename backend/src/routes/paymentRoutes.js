"use strict";

const express = require("express");
const router = express.Router();

const {
  getPaymentInstructions,
  createPaymentIntent,
  verifyPayment,
  submitTransaction,
  verifyTransactionHash,
} = require('../controllers/paymentController');

const {
  getAcceptedAssets,
  getPaymentLimitsEndpoint,
  getStudentPayments,
  getAllPayments,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  getRetryQueue,
  getExchangeRates,
  getPaymentSummary,
} = require('../controllers/paymentQueryController');

const {
  syncAllPayments,
  getSyncStatus,
  finalizePayments,
  generateReceipt,
  lockPaymentForUpdate,
  unlockPayment,
  getDeadLetterJobs,
  retryDeadLetterJob,
  getQueueJobStatus,
  getStuckPayments,
  updatePaymentStatus,
  reviewSuspiciousPayment,
  streamPaymentEvents,
} = require('../controllers/paymentAdminController');

const {
  validateStudentIdParam,
  validateTxHashParam,
  validateCreatePaymentIntent,
  validateVerifyPayment,
  validateSubmitTransaction,
} = require("../middleware/validate");
const { resolveSchool } = require("../middleware/schoolContext");
const idempotency = require("../middleware/idempotency");
const { requireAdminAuth } = require("../middleware/auth");
const { auditContext } = require("../middleware/auditContext");
const { strictLimiter, verifyLimiter } = require("../middleware/rateLimiter");

/**
 * @swagger
 * /api/payments/instructions/{studentId}:
 *   get:
 *     summary: Get payment instructions for a student
 *     operationId: getPaymentInstructions
 *     tags:
 *       - Payments
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Student ID
 *     responses:
 *       200:
 *         description: Payment instructions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 walletAddress:
 *                   type: string
 *                 memo:
 *                   type: string
 *                 acceptedAssets:
 *                   type: array
 *       404:
 *         description: Student not found
 */

/**
 * @swagger
 * /api/payments/verify:
 *   post:
 *     summary: Verify a payment transaction
 *     operationId: verifyPayment
 *     tags:
 *       - Payments
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               txHash:
 *                 type: string
 *                 description: Stellar transaction hash
 *     responses:
 *       200:
 *         description: Payment verified
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Payment'
 *       400:
 *         description: Invalid transaction
 */

/**
 * @swagger
 * /api/payments/sync:
 *   post:
 *     summary: Sync payments from Stellar blockchain
 *     operationId: syncAllPayments
 *     tags:
 *       - Payments
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Sync completed
 *       401:
 *         description: Unauthorized
 */

// No school context required
router.get("/verify/:txHash", validateTxHashParam, verifyTransactionHash);

// Validation runs BEFORE resolveSchool so missing-school requests still get
// proper 400 validation errors when the body itself is invalid.
router.post(
  "/intent",
  validateCreatePaymentIntent,
  idempotency,
  resolveSchool,
  createPaymentIntent,
);
router.post(
  "/submit",
  validateSubmitTransaction,
  resolveSchool,
  submitTransaction,
);

// All remaining routes require school context
router.use(resolveSchool);

router.get("/", getAllPayments);
router.get("/summary", getPaymentSummary);
router.get("/accepted-assets", getAcceptedAssets);
router.get("/limits", getPaymentLimitsEndpoint);
router.get("/sync/status", getSyncStatus);
router.get("/events", streamPaymentEvents);
router.get("/overpayments", getOverpayments);
router.get("/suspicious", getSuspiciousPayments);
router.get("/pending", getPendingPayments);
router.get("/stuck", requireAdminAuth, getStuckPayments);
router.get("/retry-queue", requireAdminAuth, getRetryQueue);
router.get("/rates", getExchangeRates);
router.get("/dlq", getDeadLetterJobs);

router.post(
  "/verify",
  verifyLimiter,
  idempotency,
  validateVerifyPayment,
  verifyPayment,
);
router.post("/sync", strictLimiter, requireAdminAuth, auditContext, syncAllPayments);
router.post("/finalize", requireAdminAuth, auditContext, finalizePayments);
router.post("/dlq/:id/retry", retryDeadLetterJob);

router.get("/balance/:studentId", validateStudentIdParam, getStudentBalance);
router.get(
  "/instructions/:studentId",
  validateStudentIdParam,
  getPaymentInstructions,
);
router.get("/receipt/:txHash", generateReceipt);
router.get("/queue/:txHash", getQueueJobStatus);
router.get("/:studentId", validateStudentIdParam, getStudentPayments);

router.post("/:paymentId/lock", lockPaymentForUpdate);
router.post("/:paymentId/unlock", unlockPayment);

router.patch("/:txHash/status", requireAdminAuth, auditContext, updatePaymentStatus);
router.patch("/:txHash/suspicion-review", requireAdminAuth, auditContext, reviewSuspiciousPayment);

module.exports = router;
