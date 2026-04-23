const jwt = require('jsonwebtoken');
const config = require('../config');
const { setDataScope, setUserScope } = require('./requestContext');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const scope = {
      isGlobal: !!payload.is_global,
      territoryIds: Array.isArray(payload.territory_ids) ? payload.territory_ids : [],
      accessibleTerritoryIds: Array.isArray(payload.accessible_territory_ids) ? payload.accessible_territory_ids : [],
      role: payload.role,
      dataScope: payload.data_scope || null,
    };
    req.user = {
      id: payload.id,
      email: payload.email,
      full_name: payload.full_name || null,
      role: payload.role,
      data_scope: payload.data_scope || null,
      territory_ids: scope.territoryIds,
      accessible_territory_ids: scope.accessibleTerritoryIds,
      is_global: scope.isGlobal,
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
