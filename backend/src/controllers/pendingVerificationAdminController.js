'use strict';

/**
 * pendingVerificationAdminController — global super-admin operations for the
 * Stellar verification retry backlog.
 *
 * Surfaces the otherwise-invisible dead-letter state (verifications that
 * exhausted their retries or hit a permanent error) so operators can see,
 * inspect, and re-drive them. All routes are gated by requireAdminAuth.
 */

const {
  getBacklogCounts,
  listDeadLetters,
  getPendingVerification,
  redriveDeadLetter,
} = require('../services/retryService');
const { logAudit } = require('../services/auditService');

/** GET /api/admin/pending-verifications/backlog — counts by status. */
async function getBacklog(req, res, next) {
  try {
    const counts = await getBacklogCounts();
    res.json({
      counts,
      backlog: counts.pending + counts.processing,
      deadLettered: counts.dead_letter,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/pending-verifications/dead-letter — list dead-lettered items. */
async function listDeadLetterVerifications(req, res, next) {
  try {
    const { limit, skip, schoolId } = req.query;
    const result = await listDeadLetters({ limit, skip, schoolId });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/pending-verifications/:id — inspect a single verification. */
async function getDeadLetterVerification(req, res, next) {
  try {
    const item = await getPendingVerification(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Pending verification not found', code: 'NOT_FOUND' });
    }
    res.json(item);
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/pending-verifications/:id/retry — re-drive a dead-lettered item. */
async function retryDeadLetterVerification(req, res, next) {
  try {
    const { id } = req.params;
    const updated = await redriveDeadLetter(id);

    if (!updated) {
      return res.status(404).json({
        error: 'Dead-lettered verification not found (it may have already been re-driven or resolved)',
        code: 'NOT_FOUND',
      });
    }

    await logAudit({
      schoolId: updated.schoolId,
      action: 'pending_verification_redrive',
      performedBy: req.auditContext?.performedBy || 'unknown',
      targetId: String(updated._id),
      targetType: 'payment',
      details: { txHash: updated.txHash, status: updated.status },
      result: 'success',
      ipAddress: req.auditContext?.ipAddress,
      userAgent: req.auditContext?.userAgent,
    });

    res.json({ message: 'Verification re-queued for retry', verification: updated });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getBacklog,
  listDeadLetterVerifications,
  getDeadLetterVerification,
  retryDeadLetterVerification,
};
