'use strict';

/**
 * paymentController — core payment flow: instructions, intent, submit, verify.
 * req.school and req.schoolId are injected by resolveSchool middleware.
 */

const crypto = require('crypto');
const Payment = require('../models/paymentModel');
const PaymentIntent = require('../models/paymentIntentModel');
const Student = require('../models/studentModel');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  verifyTransaction,
  recordPayment,
  validatePaymentWithDynamicFee,
} = require('../services/stellarService');
const { queueForRetry } = require('../services/retryService');
const { server } = require('../config/stellarConfig');
const { ACCEPTED_ASSETS } = require('../config/stellarConfig');
const { validateTransactionHash } = require('../utils/hashValidator');
const { getPaymentLimits, validatePaymentAmount } = require('../utils/paymentLimits');
const { convertToLocalCurrency } = require('../services/currencyConversionService');
const { withStellarRetry } = require('../utils/withStellarRetry');
const { makePaymentAuditLogger } = require('../utils/paymentAuditLogger');

// Permanent error codes that should NOT be retried
const PERMANENT_FAIL_CODES = [
  'TX_FAILED',
  'MISSING_MEMO',
  'INVALID_DESTINATION',
  'UNSUPPORTED_ASSET',
  'AMOUNT_TOO_LOW',
  'AMOUNT_TOO_HIGH',
  'UNDERPAID',
];

function getExplorerUrl(txHash) {
  if (!txHash) return null;
  const network = process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
}

function wrapStellarError(err) {
  if (!err.code) {
    err.code = 'STELLAR_NETWORK_ERROR';
    err.message = `Stellar network error: ${err.message}`;
  }
  return err;
}

// ====================== PAYMENT INSTRUCTIONS ======================
async function getPaymentInstructions(req, res, next) {
  try {
    const limits = getPaymentLimits();
    const targetCurrency = req.school.localCurrency || 'USD';
    const { feeCategory, asset } = req.query;

    if (asset) {
      const assetCode = asset.split(':')[0];
      if (!Object.keys(ACCEPTED_ASSETS).includes(assetCode)) {
        const supportedAssets = Object.values(ACCEPTED_ASSETS).map((a) => ({ code: a.code, displayName: a.displayName }));
        return res.status(400).json({ error: `Asset ${assetCode} is not accepted by this school`, code: 'ASSET_NOT_ACCEPTED', supportedAssets });
      }
    }

    const student = await Student.findOne({ schoolId: req.schoolId, studentId: req.params.studentId });

    let feeAmount = student ? student.feeAmount : null;
    let feeConversion = null;
    let categoryInfo = null;

    if (feeCategory && student?.fees?.length > 0) {
      const fee = student.fees.find((f) => f.category === feeCategory);
      if (fee) {
        feeAmount = fee.amount;
        categoryInfo = { category: fee.category, amount: fee.amount, paid: fee.paid, totalPaid: fee.totalPaid || 0, remainingBalance: fee.remainingBalance || fee.amount };
      }
    }

    if (feeAmount) {
      feeConversion = await convertToLocalCurrency(feeAmount, 'XLM', targetCurrency);
    }

    const fees = student?.fees?.length > 0
      ? student.fees.map((f) => ({ category: f.category, amount: f.amount, paid: f.paid, totalPaid: f.totalPaid || 0, remainingBalance: f.remainingBalance || f.amount }))
      : [];

    res.json({
      walletAddress: req.school.stellarAddress,
      memo: req.params.studentId,
      acceptedAssets: Object.values(ACCEPTED_ASSETS).map((a) => ({ code: a.code, type: a.type, displayName: a.displayName, issuer: a.issuer ?? null })),
      paymentLimits: { min: limits.min, max: limits.max },
      feeAmount,
      feeCategory: feeCategory || null,
      categoryInfo,
      fees,
      feeLocalEquivalent: feeConversion?.available
        ? { amount: feeConversion.localAmount, currency: feeConversion.currency, rate: feeConversion.rate, rateTimestamp: feeConversion.rateTimestamp }
        : null,
      note: 'Include the payment intent memo exactly when sending payment. The memo must be sent as a text memo (MEMO_TEXT). Other memo types (MEMO_ID, MEMO_HASH, MEMO_RETURN) will not be recognised and your payment will not be matched.',
      memoType: 'text',
    });
  } catch (err) {
    next(err);
  }
}

// ====================== PAYMENT INTENT ======================
async function createPaymentIntent(req, res, next) {
  try {
    const { schoolId } = req;
    const { studentId, feeCategory } = req.body;

    const student = await Student.findOne({ schoolId, studentId });
    if (!student) return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });

    let feeAmount = student.feeAmount;
    let categoryInfo = null;

    if (feeCategory && student.fees?.length > 0) {
      const fee = student.fees.find((f) => f.category === feeCategory);
      if (!fee) return res.status(400).json({ error: `Fee category '${feeCategory}' not found for student`, code: 'INVALID_FEE_CATEGORY' });
      feeAmount = fee.amount;
      categoryInfo = { category: fee.category, amount: fee.amount, paid: fee.paid, totalPaid: fee.totalPaid || 0, remainingBalance: fee.remainingBalance || fee.amount };
    }

    const limitValidation = validatePaymentAmount(feeAmount);
    if (!limitValidation.valid) return res.status(400).json({ error: limitValidation.error, code: limitValidation.code });

    const memo = crypto.randomBytes(4).toString('hex').toUpperCase();
    const ttlMs = parseInt(process.env.PAYMENT_INTENT_TTL_MS, 10) || 24 * 60 * 60 * 1000;

    const intent = await PaymentIntent.create({
      schoolId,
      studentId,
      amount: feeAmount,
      feeCategory: feeCategory || null,
      memo,
      status: 'pending',
      expiresAt: new Date(Date.now() + ttlMs),
      startedAt: new Date(),
    });

    res.status(201).json({ ...intent.toObject(), categoryInfo });
  } catch (err) {
    next(err);
  }
}

// ====================== SUBMIT XDR TRANSACTION ======================
async function submitTransaction(req, res, next) {
  try {
    const { xdr } = req.body;
    if (!xdr) return res.status(400).json({ error: 'Missing xdr parameter' });

    const tx = new StellarSdk.Transaction(xdr, require('../config/stellarConfig').networkPassphrase);
    const transactionHash = tx.hash().toString('hex');

    const hashValidation = validateTransactionHash(transactionHash);
    if (!hashValidation.valid) {
      const err = new Error(hashValidation.error);
      err.code = hashValidation.code;
      return next(err);
    }

    const normalizedHash = hashValidation.normalized;
    const memo = tx.memo.value ? tx.memo.value.toString() : null;
    if (!memo) return res.status(400).json({ error: 'Transaction must include the student ID as a memo' });

    let paymentRecord = await Payment.findOne({ schoolId: req.schoolId, memo, status: 'PENDING' }).sort({ createdAt: -1 });
    if (!paymentRecord) {
      const studentObj = await Student.findOne({ schoolId: req.schoolId, studentId: memo });
      if (!studentObj) return res.status(404).json({ error: 'Associated student not found in the database. Cannot process transaction.' });
      paymentRecord = new Payment({ schoolId: req.schoolId, studentId: studentObj.studentId || memo, memo, amount: 0 });
    }

    paymentRecord.transactionHash = normalizedHash;
    paymentRecord.status = 'SUBMITTED';
    paymentRecord.submittedAt = new Date();
    await paymentRecord.save();

    let txResponse;
    try {
      txResponse = await withStellarRetry(() => server.submitTransaction(tx), { label: 'submitTransaction' });
    } catch (err) {
      paymentRecord.status = 'FAILED';
      paymentRecord.suspicionReason = err.response?.data?.extras?.result_codes?.transaction ?? err.message;
      await paymentRecord.save();
      return res.status(400).json({ error: 'Transaction submission failed', code: paymentRecord.suspicionReason });
    }

    if (!txResponse.successful) {
      paymentRecord.status = 'FAILED';
      paymentRecord.confirmationStatus = 'failed';
      paymentRecord.suspicionReason = 'Transaction was included in ledger but failed on-chain';
      await paymentRecord.save();
      return res.status(400).json({ error: 'Transaction was included in the ledger but failed on-chain', code: 'TX_FAILED', hash: transactionHash });
    }

    paymentRecord.status = 'SUCCESS';
    paymentRecord.confirmedAt = new Date();
    paymentRecord.ledgerSequence = txResponse.ledger;
    await paymentRecord.save();

    const network = process.env.STELLAR_NETWORK === 'mainnet' ? 'public' : 'testnet';
    res.json({
      verified: true,
      hash: normalizedHash,
      ledger: txResponse.ledger,
      status: 'SUCCESS',
      explorerUrl: `https://stellar.expert/explorer/${network}/tx/${transactionHash}`,
    });
  } catch (err) {
    next(err);
  }
}

// ====================== VERIFY PAYMENT ======================
async function verifyPayment(req, res, next) {
  const startTime = Date.now();

  try {
    const { schoolId } = req;
    const { txHash } = req.body;

    if (!txHash) {
      const audit = makePaymentAuditLogger(req, schoolId, `missing-tx:${schoolId}`);
      await audit.failure('txHash is required', { receivedKeys: Object.keys(req.body || {}) });
      return res.status(400).json({ error: 'txHash is required', code: 'VALIDATION_ERROR' });
    }

    const hashValidation = validateTransactionHash(txHash);
    if (!hashValidation.valid) {
      const audit = makePaymentAuditLogger(req, schoolId, txHash);
      await audit.failure(hashValidation.error, { txHash, validationError: hashValidation.error });
      const err = new Error(hashValidation.error);
      err.code = hashValidation.code;
      return next(err);
    }

    const normalizedHash = hashValidation.normalized;
    const audit = makePaymentAuditLogger(req, schoolId, normalizedHash);

    // Idempotency — return cached result if already recorded
    const existing = await Payment.findOne({ schoolId, txHash: normalizedHash });
    if (existing) {
      await audit.success({ txHash: normalizedHash, cached: true, studentId: existing.studentId, amount: existing.amount });

      const targetCurrency = req.school.localCurrency || 'USD';
      const conversion = await convertToLocalCurrency(existing.amount, existing.assetCode || 'XLM', targetCurrency);
      const stellarExplorerUrl = getExplorerUrl(existing.txHash);

      return res.json({
        verified: true,
        cached: true,
        hash: existing.txHash,
        stellarExplorerUrl,
        explorerUrl: stellarExplorerUrl,
        memo: existing.memo,
        studentId: existing.studentId,
        amount: existing.amount,
        assetCode: existing.assetCode,
        assetType: existing.assetType,
        feeAmount: existing.feeAmount,
        feeValidation: { status: existing.feeValidationStatus, excessAmount: existing.excessAmount },
        networkFee: existing.networkFee || null,
        date: existing.confirmedAt || existing.createdAt,
        status: existing.status,
        confirmationStatus: existing.confirmationStatus,
        localCurrency: {
          amount: conversion.available ? conversion.localAmount : null,
          currency: conversion.currency,
          rate: conversion.rate,
          rateTimestamp: conversion.rateTimestamp,
          available: conversion.available,
        },
      });
    }

    let result;
    try {
      result = await verifyTransaction(normalizedHash, req.school.stellarAddress);
    } catch (stellarErr) {
      if (PERMANENT_FAIL_CODES.includes(stellarErr.code)) {
        await audit.failure(stellarErr.message, { txHash: normalizedHash, errorCode: stellarErr.code });
        await Payment.create({ schoolId, studentId: 'unknown', txHash: normalizedHash, amount: 0, status: 'FAILED', feeValidationStatus: 'unknown' }).catch(() => {});
        return next(stellarErr);
      }

      await audit.success({ txHash: normalizedHash, queuedForRetry: true, reason: stellarErr.message });
      await queueForRetry(normalizedHash, req.body.studentId || null, stellarErr.message, schoolId);
      return res.status(202).json({
        message: 'Stellar network is temporarily unavailable. Your transaction has been queued and will be verified automatically.',
        txHash: normalizedHash,
        status: 'queued_for_retry',
      });
    }

    if (!result) {
      await audit.failure('Transaction found but contains no valid payment to this school wallet', { txHash: normalizedHash });
      return res.status(404).json({ error: 'Transaction found but contains no valid payment to this school wallet', code: 'NOT_FOUND' });
    }

    const studentStrId = result.studentId || result.memo;
    const studentObj = await Student.findOne({ schoolId, studentId: studentStrId });
    if (!studentObj) {
      await audit.failure('Associated student not found', { txHash: normalizedHash, studentId: studentStrId });
      return res.status(404).json({ error: 'Associated student not found. Cannot record transaction.' });
    }

    const intent = await PaymentIntent.findOne({ memo: result.memo, schoolId });
    if (intent?.expiresAt && intent.expiresAt < new Date()) {
      await PaymentIntent.findByIdAndUpdate(intent._id, { status: 'expired' });
      await audit.failure('Payment intent has expired', { txHash: normalizedHash, intentExpired: true });
      const err = new Error('Payment intent has expired. Please request new payment instructions.');
      err.code = 'INTENT_EXPIRED';
      err.status = 410;
      return next(err);
    }

    if (result.feeValidation.status === 'underpaid') {
      await audit.failure(result.feeValidation.message, { txHash: normalizedHash, studentId: studentStrId, amount: result.amount, required: result.feeAmount, underpaid: true });
      const err = new Error(result.feeValidation.message);
      err.code = 'UNDERPAID';
      err.status = 400;
      err.details = { paid: result.amount, required: result.feeAmount, shortfall: parseFloat((result.feeAmount - result.amount).toFixed(7)) };
      return next(err);
    }

    const now = new Date();
    await recordPayment({
      schoolId,
      studentId: result.studentId || result.memo,
      txHash: result.hash,
      amount: result.amount,
      feeAmount: result.feeAmount,
      feeValidationStatus: result.feeValidation.status,
      excessAmount: result.feeValidation.excessAmount,
      networkFee: result.networkFee,
      status: 'SUCCESS',
      memo: result.memo,
      senderAddress: result.senderAddress || null,
      ledgerSequence: result.ledger || null,
      confirmationStatus: 'confirmed',
      confirmedAt: result.date ? new Date(result.date) : now,
      verifiedAt: now,
    });

    await audit.success({
      txHash: normalizedHash,
      studentId: result.studentId || result.memo,
      amount: result.amount,
      assetCode: result.assetCode || 'XLM',
      feeValidationStatus: result.feeValidation.status,
      duration: `${Date.now() - startTime}ms`,
    });

    // Auto-generate receipt (fire-and-forget)
    const { createReceipt } = require('../services/receiptService');
    createReceipt({
      txHash: result.hash,
      studentId: result.studentId || result.memo,
      schoolId,
      amount: result.amount,
      assetCode: result.assetCode || 'XLM',
      feeAmount: result.feeAmount,
      feeValidationStatus: result.feeValidation.status,
      memo: result.memo,
      confirmedAt: result.date ? new Date(result.date) : now,
    }).catch(() => {});

    const targetCurrency = req.school.localCurrency || 'USD';
    const conversion = await convertToLocalCurrency(result.amount, result.assetCode || 'XLM', targetCurrency);
    const stellarExplorerUrl = getExplorerUrl(result.hash);

    res.json({
      verified: true,
      cached: false,
      hash: result.hash,
      stellarExplorerUrl,
      explorerUrl: stellarExplorerUrl,
      memo: result.memo,
      studentId: result.studentId || result.memo,
      amount: result.amount,
      assetCode: result.assetCode,
      assetType: result.assetType,
      feeAmount: result.feeAmount,
      feeValidation: result.feeValidation,
      networkFee: result.networkFee,
      date: result.date,
      localCurrency: {
        amount: conversion.available ? conversion.localAmount : null,
        currency: conversion.currency,
        rate: conversion.rate,
        rateTimestamp: conversion.rateTimestamp,
        available: conversion.available,
      },
    });
  } catch (err) {
    await makePaymentAuditLogger(req, req.schoolId, req.body?.txHash || 'unknown')
      .failure(err.message, { error: err.message })
      .catch(() => {});
    next(err);
  }
}

// ====================== VERIFY TX HASH (no school context) ======================
async function verifyTransactionHash(req, res, next) {
  try {
    const { txHash } = req.params;
    const tx = await server.transactions().transaction(txHash).call();
    res.json({
      hash: tx.hash,
      successful: tx.successful,
      created_at: tx.created_at,
      ledger: tx.ledger_attr || tx.ledger,
      memo: tx.memo,
      fee_paid: tx.fee_paid,
      source_account: tx.source_account,
      operations_count: tx.operation_count,
    });
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: 'Transaction not found', code: 'NOT_FOUND' });
    next(wrapStellarError(err));
  }
}

module.exports = {
  getPaymentInstructions,
  createPaymentIntent,
  submitTransaction,
  verifyPayment,
  verifyTransactionHash,
  getExplorerUrl,
  wrapStellarError,
  // Re-export from split controllers so tests importing paymentController still work
  ...require('./paymentQueryController'),
  ...require('./paymentAdminController'),
};
