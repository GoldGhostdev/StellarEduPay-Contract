'use strict';

/**
 * All fields that can ever appear in a webhook payload.
 *
 * @typedef {'event'|'txHash'|'transactionHash'|'amount'|'asset'|'assetCode'
 *   |'status'|'schoolId'|'ts'|'timestamp'|'correlationId'|'referenceCode'
 *   |'finalFee'|'feeValidationStatus'|'confirmedAt'|'ledgerSequence'
 *   |'reason'|'isSuspicious'|'originalTxHash'|'refundTxHash'|'refundedAt'
 *   |'studentId'|'senderAddress'} WebhookField
 */

/**
 * The safe-default field set: no PII.
 *
 * Excluded by default:
 *   - studentId      — directly identifies a student; opt-in only
 *   - senderAddress  — the payer's Stellar address; opt-in only
 */
const DEFAULT_ALLOWED_FIELDS = Object.freeze([
  'event',
  'txHash',
  'transactionHash',
  'amount',
  'asset',
  'assetCode',
  'status',
  'schoolId',
  'ts',
  'timestamp',
  'correlationId',
  'referenceCode',
  'finalFee',
  'feeValidationStatus',
  'confirmedAt',
  'ledgerSequence',
  'reason',
  'isSuspicious',
  'originalTxHash',
  'refundTxHash',
  'refundedAt',
]);

/**
 * All known field names. Used for validation when a school updates
 * its webhookPayloadConfig.allowedFields via the API.
 */
const ALL_KNOWN_FIELDS = Object.freeze([
  ...DEFAULT_ALLOWED_FIELDS,
  'studentId',
  'senderAddress',
]);

/**
 * Build a webhook payload object containing only the allowed fields.
 *
 * - If allowedFields is a non-empty array, only those keys are included.
 * - If allowedFields is empty, null, or undefined, falls back to DEFAULT_ALLOWED_FIELDS.
 * - The input rawPayload is never mutated.
 *
 * @param {Record<string, unknown>} rawPayload  Full payload object (may include PII).
 * @param {string[]|null|undefined} allowedFields  Field name whitelist from school config.
 * @returns {Record<string, unknown>}  Filtered payload (new object, no PII unless opted-in).
 */
function buildWebhookPayload(rawPayload, allowedFields) {
  if (!rawPayload || typeof rawPayload !== 'object') return {};

  const fields =
    Array.isArray(allowedFields) && allowedFields.length > 0
      ? allowedFields
      : DEFAULT_ALLOWED_FIELDS;

  const result = {};
  for (const key of fields) {
    if (Object.prototype.hasOwnProperty.call(rawPayload, key)) {
      result[key] = rawPayload[key];
    }
  }
  return result;
}

module.exports = {
  buildWebhookPayload,
  DEFAULT_ALLOWED_FIELDS,
  ALL_KNOWN_FIELDS,
};
