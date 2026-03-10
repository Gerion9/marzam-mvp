const db = require('../config/database');
const { isExternalDataMode } = require('../repositories/runtime');

/**
 * Factory that returns middleware logging an audit event after the response.
 * Usage: router.post('/...', authenticate, auditLog('pharmacy.updated'), controller)
 *
 * The controller can attach `res.locals.auditDetail` with { entityType, entityId, before, after }
 * to enrich the audit row.
 */
function auditLog(action) {
  return (_req, res, next) => {
    res.on('finish', async () => {
      if (res.statusCode >= 400) return; // only log successful operations
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
