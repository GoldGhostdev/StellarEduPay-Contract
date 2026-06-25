'use strict';

const Joi = require('joi');

// Maximum allowed date range in days (configurable via env, default 366 days).
const MAX_RANGE_DAYS = parseInt(process.env.REPORT_MAX_RANGE_DAYS || '366', 10);

/**
 * Joi schema for GET /api/reports query params.
 *
 * Validates:
 *  - startDate / endDate are valid ISO 8601 date strings (YYYY-MM-DD or full ISO)
 *  - startDate <= endDate when both are provided
 *  - Date range does not exceed MAX_RANGE_DAYS
 *  - format is 'json' or 'csv'
 */
const reportQuerySchema = Joi.object({
  startDate: Joi.string().isoDate().optional(),
  endDate:   Joi.string().isoDate().optional(),
  format:    Joi.string().valid('json', 'csv').default('json'),
}).custom((value, helpers) => {
  const { startDate, endDate } = value;
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end   = new Date(endDate);
    if (start > end) {
      return helpers.error('any.invalid', {
        message: 'startDate must be before or equal to endDate',
      });
    }
    const diffDays = (end - start) / (1000 * 60 * 60 * 24);
    if (diffDays > MAX_RANGE_DAYS) {
      return helpers.error('any.invalid', {
        message: `Date range exceeds the maximum of ${MAX_RANGE_DAYS} days`,
      });
    }
  }
  return value;
}).messages({
  'any.invalid': '{{#message}}',
});

module.exports = { reportQuerySchema, MAX_RANGE_DAYS };
