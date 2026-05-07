const db = require('../config/database');
const { isExternalDataMode } = require('../repositories/runtime');

/**
 * Factory that returns middleware logging an audit event after the response.
 * Usage: router.post('/...', authenticate, auditLog('pharmacy.updated'), controller)
 *
 * The controller can attach `res.locals.auditDetail` with { entityType, entityId, before, after }
 * to enrich the audit row.
 *
 * Audit policy decision (audit Fix #9, docs/qa-fix-plan.md):
 *   We deliberately SKIP audit on responses with statusCode >= 400. Rationale:
 *   every state-mutating handler in this codebase wraps its DB writes in a
 *   single `db.transaction()` (see visits.service.js, onboarding.service.js,
 *   bq-sync/jobs/*). When that transaction errors, Postgres rolls back the
 *   entire batch and `res.statusCode` ends up 5xx — there is no "partial"
 *   state in the DB to record. Logging an "attempted but failed" audit row
 *   would be noise without forensic value.
 *
 *   If a future controller mutates state OUTSIDE a trx (e.g. a side-effect
 *   that lives in S3/GCS), this policy should be revisited.
 */
function auditLog(action) {
  return (_req, res, next) => {
    res.on('finish', async () => {
      // Policy: skip on 4xx (validation errors) AND 5xx (server-side rollback).
      // See doc-block above for rationale.
      if (res.statusCode >= 400) return;
      if (isExternalDataMode()) return;
      try {
        const detail = res.locals.auditDetail || {};
        await db('audit_events').insert({
          user_id: _req.user?.id || null,
          action,
          entity_type: detail.entityType || null,
          entity_id: detail.entityId || null,
          before_state: detail.before ? JSON.stringify(detail.before) : null,
          after_state: detail.after ? JSON.stringify(detail.after) : null,
          ip_address: _req.ip,
        });
      } catch (err) {
        console.error('Audit log write failed:', err.message);
      }
    });
    next();
  };
}

module.exports = auditLog;
