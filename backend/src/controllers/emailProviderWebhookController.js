'use strict';

const config = require('../config');
const { handleEmailProviderEvent } = require('../services/emailDeliveryService');
const logger = require('../utils/logger').child('EmailProviderWebhookController');

async function handleEmailProviderWebhook(req, res, next) {
  try {
    const event = req.body;

    if (!event || typeof event !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON payload', code: 'INVALID_PAYLOAD' });
    }

    const delivery = await handleEmailProviderEvent(event);
    res.json({ success: true, emailDeliveryId: delivery._id, status: delivery.status });
  } catch (err) {
    logger.error('Email provider webhook failed', { error: err.message });
    next(err);
  }
}

module.exports = { handleEmailProviderWebhook };
