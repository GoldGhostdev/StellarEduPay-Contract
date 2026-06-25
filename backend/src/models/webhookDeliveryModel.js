'use strict';

const mongoose = require('mongoose');

/**
 * WebhookDelivery — seen delivery-ID store for replay protection.
 *
 * Each document represents a delivery-ID that has been received and processed.
 * The TTL index automatically removes documents after WEBHOOK_DELIVERY_TTL_SECONDS
 * (default 24 hours), keeping the collection compact.
 */
const webhookDeliverySchema = new mongoose.Schema(
  {
    deliveryId: { type: String, required: true, unique: true, index: true },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// Auto-expire after 24 hours (configurable via env)
const TTL_SECONDS = parseInt(process.env.WEBHOOK_DELIVERY_TTL_SECONDS, 10) || 86400;
webhookDeliverySchema.index({ receivedAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

module.exports = mongoose.model('WebhookDelivery', webhookDeliverySchema);
