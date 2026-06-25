'use strict';

const { generateReport, reportToCsv, getDashboardMetrics } = require('../services/reportService');
const { get, set, KEYS, TTL } = require('../cache');
const School = require('../models/schoolModel');

async function getReport(req, res, next) {
  try {
    // Date-range validation is handled by the Joi middleware in reportRoutes.
    const { startDate, endDate, format = 'json' } = req.query;

    const school = await School.findOne({ schoolId: req.schoolId }).lean();
    const timezone = school?.timezone || 'UTC';
    const cacheKey = KEYS.report(startDate, endDate);
    let report = get(cacheKey);
    if (report === undefined) { report = await generateReport({ schoolId: req.schoolId, startDate, endDate, timezone }); set(cacheKey, report, TTL.REPORT); }

    if (format === 'csv') {
      const s = startDate || null;
      const e = endDate   || null;
      let filename;
      if (s && e)       filename = `report-${s}-to-${e}.csv`;
      else if (s)       filename = `report-${s}-to-all-time.csv`;
      else if (e)       filename = `report-all-time-to-${e}.csv`;
      else              filename = 'report-all-time.csv';
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(reportToCsv(report));
    }

    res.json(report);
  } catch (err) { next(err); }
}

async function getDashboard(req, res, next) {
  try {
    const school = await School.findOne({ schoolId: req.schoolId }).lean();
    const cacheKey = `dashboard:${req.schoolId}`;
    let metrics = get(cacheKey);
    if (metrics === undefined) { metrics = await getDashboardMetrics({ schoolId: req.schoolId, timezone: school?.timezone || 'UTC' }); set(cacheKey, metrics, TTL.REPORT); }
    res.json(metrics);
  } catch (err) { next(err); }
}

module.exports = { getReport, getDashboard };
