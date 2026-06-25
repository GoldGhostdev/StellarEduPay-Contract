'use strict';

/**
 * ROUNDING POLICY (Issue #751)
 * ─────────────────────────────────────────────────────────────────────────────
 * Monetary comparisons use Decimal to avoid IEEE-754 drift.
 *   XLM  — 7 decimal places (Stellar on-chain precision)
 *   USDC — 7 decimal places
 *   Fiat — 2 decimal places
 *
 * Rule: never use raw JS Number arithmetic on monetary values. Use Decimal for
 * all comparisons and arithmetic; convert to Number only at output boundaries.
 */

const Decimal = require('decimal.js');
const { MIN_PAYMENT_AMOUNT, MAX_PAYMENT_AMOUNT } = require('../config');

const D_MIN = new Decimal(MIN_PAYMENT_AMOUNT);
const D_MAX = new Decimal(MAX_PAYMENT_AMOUNT);

function validatePaymentAmount(amount) {
  const d = new Decimal(typeof amount === 'number' && isFinite(amount) ? amount : NaN);
  if (!d.isFinite() || d.lte(0))
    return { valid: false, error: 'Payment amount must be a valid positive number', code: 'INVALID_AMOUNT' };
  if (d.lt(D_MIN))
    return { valid: false, error: `Payment amount ${amount} is below the minimum of ${MIN_PAYMENT_AMOUNT}`, code: 'AMOUNT_TOO_LOW' };
  if (d.gt(D_MAX))
    return { valid: false, error: `Payment amount ${amount} exceeds the maximum of ${MAX_PAYMENT_AMOUNT}`, code: 'AMOUNT_TOO_HIGH' };
  return { valid: true };
}

function validatePaymentAmountAgainstFee(paymentAmount, feeAmount, maxPaymentMultiplier = 3.0) {
  const dPayment = new Decimal(typeof paymentAmount === 'number' && isFinite(paymentAmount) ? paymentAmount : NaN);
  const dFee    = new Decimal(typeof feeAmount    === 'number' && isFinite(feeAmount)    ? feeAmount    : NaN);

  if (!dPayment.isFinite() || dPayment.lte(0))
    return { valid: false, error: 'Payment amount must be a valid positive number', code: 'INVALID_AMOUNT' };
  if (!dFee.isFinite() || dFee.lte(0))
    return { valid: false, error: 'Fee amount must be a valid positive number', code: 'INVALID_FEE' };

  const maxAllowed = dFee.mul(new Decimal(maxPaymentMultiplier));
  if (dPayment.gt(maxAllowed))
    return { valid: false, error: `Payment amount ${paymentAmount} exceeds the maximum of ${maxAllowed.toNumber()} (${maxPaymentMultiplier}× the fee)`, code: 'AMOUNT_TOO_HIGH' };
  return { valid: true };
}

function getPaymentLimits() {
  return { min: MIN_PAYMENT_AMOUNT, max: MAX_PAYMENT_AMOUNT };
}

module.exports = { validatePaymentAmount, validatePaymentAmountAgainstFee, getPaymentLimits };
