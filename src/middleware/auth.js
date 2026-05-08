const jwt = require('jsonwebtoken');
const config = require('../config');
const { setDataScope, setUserScope } = require('./requestContext');
const accessDirectory = require('../services/accessDirectory');
const { isGlobalRole, normalizeRole } = require('../constants/roles');

/**
 * [S5] Hydrate req.user from a SSE ticket (mig 081). The ticket carries the
 * full JWT payload as JSONB so we can rebuild the same shape without reading
 * the JWT secret. Tickets expire (default 60s) and the table is purged daily.
 *
 * Single function so the JWT and ticket paths share the same downstream
 * (req.user / req.scope / setDataScope / setUserScope).
 */
async function attachFromTicket(req, res, next) {
  const ticketId = String(req.query.ticket || '');
  // Lazy-require so unit tests that exercise authenticate without a DB don't
  // pay the cost of opening a knex pool just by requiring this middleware.
  // eslint-disable-next-line global-require
  const db = require('../config/database');
  let row;
  try {
    row = await db('sse_tickets')
      .where({ id: ticketId })
      .where('expires_at', '>', db.fn.now())
      .first();
  } catch (err) {
    console.warn('[auth] ticket lookup failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired ticket' });
  }
  if (!row) {
    return res.status(401).json({ error: 'Invalid or expired ticket' });
  }
  // Best-effort: mark used_at for forensic visibility (not enforced for
  // single-use, since SSE reconnects need to redeem the same ticket within
  // its expiry window).
  if (!row.used_at) {
    db('sse_tickets').where({ id: ticketId }).update({ used_at: db.fn.now() }).catch(() => {});
  }
  return applyPayload(req, res, next, row.payload);
}

function applyPayload(req, res, next, payload) {
  // [S6] Reject claims that contradict the role hierarchy.
  if (payload.is_global === true && !isGlobalRole(payload.role)) {
    console.warn(
      '[auth] payload rejected: is_global=true with non-global role '
        + JSON.stringify(normalizeRole(payload.role)),
    );
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const scope = {
    isGlobal: !!payload.is_global,
    territoryIds: Array.isArray(payload.territory_ids) ? payload.territory_ids : [],
    accessibleTerritoryIds: Array.isArray(payload.accessible_territory_ids) ? payload.accessible_territory_ids : [],
    role: payload.role,
    dataScope: payload.data_scope || null,
  };
  const canonicalId = accessDirectory.toCanonicalId(payload.id);
  const externalId = payload.external_id
    || (accessDirectory.isCanonicalUuid(payload.id) ? null : payload.id);
  req.user = {
    id: canonicalId,
    external_id: externalId,
    email: payload.email,
    full_name: payload.full_name || null,
    role: payload.role,
    data_scope: payload.data_scope || null,
    territory_ids: scope.territoryIds,
    accessible_territory_ids: scope.accessibleTerritoryIds,
    is_global: scope.isGlobal,
    employee_code: payload.employee_code || null,
    employee_number: payload.employee_number || null,
    branch_code: payload.branch_code || null,
    manager_code: payload.manager_code || null,
    impersonated_by: payload.impersonated_by || null,
    original_role: payload.original_role || null,
  };
  req.scope = scope;
  setDataScope(payload.data_scope);
  setUserScope(scope);
  return next();
}

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  // [S5] Token-exchange path: short-lived UUID ticket from sse_tickets.
  // Preferred over ?token= for SSE because tickets expire in seconds and the
  // leak surface is much smaller than the long-lived JWT.
  if (typeof req.query.ticket === 'string' && req.query.ticket) {
    return attachFromTicket(req, res, next);
  }
  // EventSource (SSE) cannot set custom headers, so we accept ?token= as a
  // backward-compat fallback. New SSE clients should use ?ticket= instead.
  let token;
  if (header && header.startsWith('Bearer ')) {
    token = header.split(' ')[1];
  } else if (typeof req.query.token === 'string' && req.query.token) {
    token = req.query.token;
  } else {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    console.warn('[auth] token rejected: ' + err.name + ' ' + err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  return applyPayload(req, res, next, payload);
}

module.exports = authenticate;
