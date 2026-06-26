'use strict';

const School = require('../models/schoolModel');
const cache = require('../cache');

/**
 * resolveSchool — middleware that identifies the current school from the request.
 *
 * Lookup strategy (in order of precedence):
 *   1. X-School-ID header   — opaque schoolId string (e.g. "SCH-3F2A")
 *   2. X-School-Slug header — human slug (e.g. "lincoln-high")
 *
 * Results are cached in memory with a 5-minute TTL to reduce DB load.
 *
 * On success: attaches req.school (lean School doc) and req.schoolId (string).
 * On failure: 400 if no header provided, 404 if school not found or inactive.
 *
 * Usage:
 *   router.use(resolveSchool);           // apply to all routes in a router
 *   router.get('/students', resolveSchool, handler);  // apply to one route
 */
async function resolveSchool(req, res, next) {
  try {
    const schoolId   = req.headers['x-school-id'];
    const schoolSlug = req.headers['x-school-slug'];

    if (!schoolId && !schoolSlug) {
      res.set('Cache-Control', 'no-store');
      return res.status(400).json({
        error: 'School context is required. Provide X-School-ID or X-School-Slug header.',
        code: 'MISSING_SCHOOL_CONTEXT',
      });
    }

    let school;
    let cacheKey;

    if (schoolId) {
      cacheKey = cache.KEYS.school ? cache.KEYS.school(schoolId) : `school:${schoolId}`;
      school = cache.get(cacheKey);

      if (school) {
        // Re-confirm isActive from DB on every cache hit to prevent stale entries
        // from bypassing deactivation (e.g. when isActive is flipped outside the
        // normal controller path or before the cache TTL expires).
        const live = await School.findOne({ schoolId }, { isActive: 1 }).lean();
        if (!live || !live.isActive) {
          cache.del(cacheKey);
          school = null;
        }
      }

      if (!school) {
        school = await School.findOne({ schoolId }).lean();
        if (school && school.isActive) {
          cache.set(cacheKey, school, cache.TTL.SCHOOL || 300);
        }
      }
    } else {
      const slug = schoolSlug.toLowerCase().trim();
      cacheKey = cache.KEYS.school ? cache.KEYS.school(slug) : `school:${slug}`;
      school = cache.get(cacheKey);

      if (school) {
        // Re-confirm isActive from DB on every cache hit.
        const live = await School.findOne({ slug }, { isActive: 1 }).lean();
        if (!live || !live.isActive) {
          cache.del(cacheKey);
          school = null;
        }
      }

      if (!school) {
        school = await School.findOne({ slug }).lean();
        if (school && school.isActive) {
          cache.set(cacheKey, school, cache.TTL.SCHOOL || 300);
        }
      }
    }

    if (!school) {
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({
        error: 'School not found.',
        code: 'NOT_FOUND',
      });
    }

    if (!school.isActive) {
      res.set('Cache-Control', 'no-store');
      return res.status(403).json({
        error: 'School is deactivated.',
        code: 'SCHOOL_INACTIVE',
      });
    }

    req.school   = school;
    req.schoolId = school.schoolId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { resolveSchool };
