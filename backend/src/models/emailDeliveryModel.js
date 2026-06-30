'use strict';

const mongoose = require('mongoose');
const tenantScope = require('../plugins/tenantScope');

const emailDeliverySchema = new mongoose.Schema(
  {
    schoolId: { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    type: { type: String, required: true, enum: ['reminder', 'receipt'] },
    provider: { type: String, default: 'generic' },
    providerMessageId: { type: String, default: null },
    status: {
      type: String,
      enum: ['queued', 'sent', 'failed', 'delivered', 'opened', 'bounced', 'complaint', 'skipped'],
      default: 'queued',
    },
    reason: { type: String, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    bouncedAt: { type: Date, default: null },
    complaintAt: { type: Date, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

emailDeliverySchema.index({ provider: 1, providerMessageId: 1 }, { unique: true, sparse: true });

emailDeliverySchema.plugin(tenantScope, { modelName: 'EmailDelivery' });

module.exports = mongoose.model('EmailDelivery', emailDeliverySchema);
