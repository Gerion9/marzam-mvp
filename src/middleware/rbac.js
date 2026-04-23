/**
 * Role-based access middleware.
 *
 * Two call signatures supported:
 *
 *   authorize('manager', 'national_admin')          // legacy: list of allowed roles
 *   authorize({ roles: [...], check: (req) => bool }) // new: roles + custom predicate
 *
 * Legacy `manager` is automatically treated as `national_admin` (backwards compat).
 */

const GLOBAL_ALIASES = new Set(['manager', 'national_admin']);

function normalizeRole(role) {
  if (GLOBAL_ALIASES.has(role)) return 'national_admin';
  return role;
}

function expandAllowed(roles) {
  const expanded = new Set();
  for (const r of roles) {
    if (r === 'manager' || r === 'national_admin') {
      expanded.add('manager');
      expanded.add('national_admin');
    } else {
      expanded.add(r);
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
