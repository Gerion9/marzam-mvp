/**
 * Role-based access middleware.
 *
 * Two call signatures supported:
 *
 *   authorize('director_sucursal', 'gerente_ventas')          // legacy: list of allowed roles
 *   authorize({ roles: [...], check: (req) => bool })         // new: roles + custom predicate
 *
 * Legacy role names (manager, national_admin, regional_manager, area_coordinator,
 * field_rep) are accepted via ROLE_ALIASES — both in the request user.role and in
 * the allowed lists declared by call sites — to keep older code working through
 * the rename rollout.
 */

const { ROLE_ALIASES, normalizeRole } = require('../constants/roles');

function expandAllowed(roles) {
  const expanded = new Set();
  for (const r of roles) {
    if (!r) continue;
    const canonical = normalizeRole(r);
    expanded.add(canonical);
    // Allow aliases too — so request users still carrying the legacy role
    // (between deploy and migration) keep passing the gate.
    for (const [alias, target] of Object.entries(ROLE_ALIASES)) {
      if (target === canonical) expanded.add(alias);
    }
  }
  return expanded;
}

function authorize(...args) {
  // New-style: single object
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
    const { roles = [], check = null } = args[0];
    const allowed = expandAllowed(roles);
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthenticated' });
      }
      if (allowed.size > 0 && !allowed.has(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
      }
      if (typeof check === 'function' && !check(req)) {
        return res.status(403).json({ error: 'Forbidden: scope check failed' });
      }
      next();
    };
  }

  // Legacy-style: string list
  const allowed = expandAllowed(args);
  return (req, res, next) => {
    if (!req.user || !allowed.has(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

module.exports = authorize;
module.exports.normalizeRole = normalizeRole;
