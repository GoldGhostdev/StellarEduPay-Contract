'use strict';

/**
 * Email service for sending transactional emails.
 * Issue #669: Sends payment receipt emails when payments transition to SUCCESS.
 */

const logger = require('../utils/logger');

/**
 * Send payment receipt email to parent/student contact email.
 * Called when a payment transitions to SUCCESS status.
 * 
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.studentName - Student name for personalization
 * @param {number} options.amount - Payment amount
 * @param {string} options.txHash - Stellar transaction hash
 * @param {Date} options.confirmedAt - Payment confirmation timestamp
 * @param {number} options.remainingBalance - Remaining fee balance after payment
 * @returns {Promise<Object>} Email send result
 */
async function sendPaymentReceipt(options) {
  const { to, studentName, amount, txHash, confirmedAt, remainingBalance } = options;

  if (!to) {
    logger.info({
      msg: 'Payment receipt email skipped: no contact email',
      studentName,
      amount,
    });
    return { skipped: true };
  }

  try {
    // TODO: Integrate with actual email provider (SendGrid, AWS SES, etc.)
    // For now, log the email that would be sent
    logger.info({
      msg: 'Payment receipt email queued',
      to,
      studentName,
      amount,
      txHash,
      confirmedAt,
      remainingBalance,
    });

    // Return mock result for testing
    return {
      messageId: `mock-${Date.now()}`,
      to,
      subject: `Payment Receipt for ${studentName}`,
    };
  } catch (err) {
    logger.error({
      msg: 'Failed to send payment receipt email',
      to,
      studentName,
      error: err.message,
    });
    throw err;
  }
}

module.exports = {
  sendPaymentReceipt,
};
