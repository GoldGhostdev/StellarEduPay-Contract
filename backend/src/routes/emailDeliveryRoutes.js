'use strict';

const express = require('express');
const router = express.Router();
const { getEmailDeliveriesForStudent } = require('../controllers/emailDeliveryController');
const { resolveSchool } = require('../middleware/schoolContext');
const { requireAdminAuth } = require('../middleware/auth');
const { validateStudentIdParam } = require('../middleware/validate');

router.use(resolveSchool);
router.get('/:studentId', requireAdminAuth, validateStudentIdParam, getEmailDeliveriesForStudent);

module.exports = router;
