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
 *
 * `admin` (per Marzam Execution Doc §3) is implicitly allowed on every gate —
 * see expandAllowed(). Endpoints that should be admin-exclusive must use the
 * `adminOnly: true` option, which inverts the rule and rejects everyone else.
 *
 * `blackprint_admin` is platform-team super-user (BlackPrint, the product
 * vendor). It is intentionally NOT auto-added by expandAllowed — endpoints
 * that want to admit BP must opt in:
 *
 *   authorize({ adminOnly: true })            // Marzam admin only (writes)
 *   authorize({ anyAdmin: true })             // Marzam admin OR blackprint (shared reads)
 *   authorize({ blackprintOnly: true })       // BP only (platform endpoints)
 *   authorize({ roles: [...], includeBlackprint: true })  // mgmt list + BP
 *
 * The denyBlackprintWrites middleware enforces a platform-wide write block as
 * defense in depth.
 */

const { ROLES, ROLE_ALIASES, normalizeRole } = require('../constants/roles');

function expandAllowed(roles, opts = {}) {
  const { includeBlackprint = false } = opts;
  const expanded = new Set();
  // Admin always passes any non-empty role gate (top of hierarchy, global scope).
  expanded.add(ROLES.ADMIN);
  // BlackPrint admin only when caller opts in. We do NOT add it by default
  // because expandAllowed is shared by management-level write gates (e.g.
  // visit-plan creation) that should remain Marzam-only.
  if (includeBlackprint) expanded.add(ROLES.BLACKPRINT_ADMIN);
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
    const {
      roles = [],
      check = null,
      adminOnly = false,
      anyAdmin = false,
      blackprintOnly = false,
      includeBlackprint = false,
    } = args[0];

    let allowed;
    if (blackprintOnly) {
      allowed = new Set([ROLES.BLACKPRINT_ADMIN]);
    } else if (adminOnly) {
      // Marzam-only — preserved guarantee. blackprint_admin is rejected here.
      allowed = new Set([ROLES.ADMIN]);
    } else if (anyAdmin) {
      allowed = new Set([ROLES.ADMIN, ROLES.BLACKPRINT_ADMIN]);
    } else {
      allowed = expandAllowed(roles, { includeBlackprint });
    }

    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthenticated' });
      }
      if (allowed.size > 0 && !allowed.has(normalizeRole(req.user.role))) {
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
    if (!req.user || !allowed.has(normalizeRole(req.user.role))) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

module.exports = authorize;
module.exports.normalizeRole = normalizeRole;
module.exports.expandAllowed = expandAllowed;
