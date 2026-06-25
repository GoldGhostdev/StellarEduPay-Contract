'use strict';

const express = require('express');
const router = express.Router();
const { getReport, getDashboard } = require('../controllers/reportController');
const { resolveSchool } = require('../middleware/schoolContext');
const { validate } = require('../middleware/validate');
const { reportQuerySchema } = require('../middleware/schemas/reportSchemas');

router.use(resolveSchool);

router.get('/dashboard', getDashboard);
router.get('/', validate(reportQuerySchema, 'query'), getReport);

module.exports = router;
