'use strict';

const express = require('express');
const { registry } = require('../metrics');
const { metricsAuth, metricsRateLimiter } = require('../middleware/metricsAuth');

const router = express.Router();

router.get('/', metricsRateLimiter, metricsAuth, async (req, res, next) => {
  try {
    const output = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.end(output);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
