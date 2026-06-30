'use strict';

const express = require('express');
const router = express.Router();
const { handleEmailProviderWebhook } = require('../controllers/emailProviderWebhookController');
const { validateInboundWebhook } = require('../middleware/validateInboundWebhook');
const config = require('../config');

const secret = config.EMAIL_PROVIDER_WEBHOOK_SECRET;
router.post('/callback', validateInboundWebhook(secret), handleEmailProviderWebhook);

module.exports = router;
