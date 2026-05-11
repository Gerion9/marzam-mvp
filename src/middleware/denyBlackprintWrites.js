/**
 * BlackPrint admin → platform-wide read-only enforcement.
 *
 * Each per-route gate already rejects blackprint_admin from Marzam-owned
 * write endpoints (authorize({ adminOnly: true }) excludes BP). This
 * middleware is the global safety net: ANY POST/PUT/PATCH/DELETE made by a
 * blackprint_admin is rejected with 403, regardless of which router
 * registered it. New mutating routes added in the future inherit the block
 * for free — explicit opt-out is required via the WRITE_ALLOW_PATHS
 * whitelist.
 *
 * Mirrors the structure of demoReadonly.js (sync JWT inspect, no DB
 * round-trip). The role is encoded in the JWT and cannot drift between the
 * directory and the request, so we don't need an async DB verify pass.
 *
 * Whitelisted writes (rationale):
 *   /api/auth/{login,logout,me,sse-ticket}  — session lifecycle.
 *   /api/admin/cron/*                       — BP must be able to fire crons
 *                                             manually for diagnostics. The
 *                                             cron handlers themselves are
 *                                             gated by adminOrAnyAdminOrCron.
 */

const jwt = require('jsonwebtoken');
const config = require('../config');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const WRITE_ALLOW_PATHS = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/sse-ticket',
  '/api/admin/cron',
];

function pathAllowed(path) {
  if (!path) return false;
  return WRITE_ALLOW_PATHS.some((p) => path === p || path.startsWith(p + '/'));
}

function readRoleFromToken(req) {
  if (req.user && typeof req.user.role === 'string') return req.user.role;
  const header = req.headers && req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

function denyBlackprintWrites(req, res, next) {
  const method = (req.method || '').toUpperCase();
  if (!WRITE_METHODS.has(method)) return next();
  if (pathAllowed(req.originalUrl || req.url || req.path)) return next();

  const role = readRoleFromToken(req);
  if (role !== 'blackprint_admin') return next();

  return res.status(403).json({
    error: 'BlackPrint admin is read-only on Marzam data',
    _hint: 'Use a Marzam admin account to perform writes',
  });
}

module.exports = denyBlackprintWrites;
module.exports.WRITE_ALLOW_PATHS = WRITE_ALLOW_PATHS;
