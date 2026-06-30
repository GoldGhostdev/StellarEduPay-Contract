'use strict';

const express = require('express');
const router = express.Router();
const { listDeliveries, replayDelivery } = require('../controllers/webhookEndpointsController');
const { requireSchoolAuth } = require('../middleware/auth');
const { auditContext } = require('../middleware/auditContext');

// All routes require a valid school-scoped JWT
router.use(requireSchoolAuth());

// GET  /api/webhook-deliveries?endpointId=&event=&success=&page=&limit=
router.get('/', listDeliveries);

// POST /api/webhook-deliveries/:id/replay
router.post('/:id/replay', auditContext, replayDelivery);

module.exports = router;
