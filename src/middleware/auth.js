const jwt = require('jsonwebtoken');
const config = require('../config');
const { setDataScope, setUserScope } = require('./requestContext');
const accessDirectory = require('../services/accessDirectory');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  // EventSource (SSE) cannot set custom headers, so we accept ?token= as a
  // fallback. Header is preferred and used when present.
  let token;
  if (header && header.startsWith('Bearer ')) {
    token = header.split(' ')[1];
  } else if (typeof req.query.token === 'string' && req.query.token) {
    token = req.query.token;
  } else {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const scope = {
      isGlobal: !!payload.is_global,
      territoryIds: Array.isArray(payload.territory_ids) ? payload.territory_ids : [],
      accessibleTerritoryIds: Array.isArray(payload.accessible_territory_ids) ? payload.accessible_territory_ids : [],
      role: payload.role,
      dataScope: payload.data_scope || null,
    };
    // Backwards-compat: tokens issued before the UUID migration carry
    // `payload.id = 'u-dir-001'` (virtual id). Translate it on the fly so
    // services that hit `users` (uuid column) don't crash. The frontend will
    // catch up on its next call to /auth/me.
    const canonicalId = accessDirectory.toCanonicalId(payload.id);
    const externalId = payload.external_id
      || (accessDirectory.isCanonicalUuid(payload.id) ? null : payload.id);

    req.user = {
      // Canonical UUID — matches users.id in the DB.
      id: canonicalId,
      // Legacy/virtual identifier (e.g. 'u-dir-001'). Kept for downstream
      // services that still match against the access directory.
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
    next();
  } catch (err) {
    console.warn(`[auth] token rejected: ${err.name} ${err.message}`);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authenticate;
