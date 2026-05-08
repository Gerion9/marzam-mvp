const { Router } = require('express');
const controller = require('./auth.controller');
const invitationsController = require('../invitations/invitations.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const validate = require('../../middleware/validate');
const { secretsEqual } = require('../../utils/secretCompare');

const router = Router();

/**
 * [S12] Bootstrap admin guard.
 *
 * The /_bootstrap-admin endpoint is only meant to seed the very first admin
 * user when the database is empty. It must be invisible to scanners under any
 * misconfigured deploy: respond with 404 unless BOOTSTRAP_TOKEN is set AND the
 * caller presents the matching token. The 404 also masks whether bootstrap is
 * disabled vs. the token is wrong — operationally simpler to triage from
 * logs (server-side warning) than from probe responses.
 */
function requireBootstrapToken(req, res, next) {
  const expected = process.env.BOOTSTRAP_TOKEN;
  const supplied = req.headers['x-bootstrap-token']
    || req.body?.bootstrap_token
    || req.query?.token;
  if (!expected || !secretsEqual(supplied, expected)) {
    if (!expected) {
      console.warn('[auth] /_bootstrap-admin probe with BOOTSTRAP_TOKEN unset — returning 404');
    } else {
      console.warn('[auth] /_bootstrap-admin token mismatch — returning 404');
    }
    return res.status(404).json({ error: 'Not Found' });
  }
  return next();
}

// User CRUD is admin-only per Marzam Execution Doc §3.
router.post(
  '/register',
  authenticate,
  authorize({ adminOnly: true }),
  validate({
    email: { required: true, type: 'string', format: 'email', maxLength: 200 },
    password: { required: true, type: 'string', minLength: 12, maxLength: 200 },
    full_name: { required: true, type: 'string', minLength: 2, maxLength: 200 },
    role: {
      required: true,
      type: 'string',
      oneOf: [
        'admin',
        'director_sucursal', 'gerente_ventas', 'supervisor', 'representante',
        // Legacy aliases accepted during rollout
        'national_admin', 'regional_manager', 'area_coordinator', 'field_rep', 'manager',
      ],
    },
  }),
  controller.register,
);

router.post(
  '/login',
  validate({
    email: { required: true, type: 'string', format: 'email', maxLength: 200 },
    password: { required: true, type: 'string', minLength: 1, maxLength: 200 },
  }),
  controller.login,
);

router.get('/me', authenticate, controller.me);

router.get(
  '/users',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  controller.listUsers,
);

router.post(
  '/impersonate',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  validate({
    // Accept both canonical UUIDs and legacy virtual ids ('u-dir-001'...).
    // The controller normalizes via accessDirectory.toCanonicalId.
    target_user_id: { required: true, type: 'string', minLength: 3, maxLength: 64 },
  }),
  controller.impersonate,
);

router.post('/impersonate/stop', authenticate, controller.stopImpersonation);

// [S5] Short-lived ticket exchange for SSE. The caller authenticates with the
// long-lived JWT (header), gets back a 60s UUID, and uses it on
// /api/live/stream?ticket=<uuid>. Limits the leak window if the URL ends up
// in logs / browser history. See src/middleware/auth.js attachFromTicket.
router.post('/sse-ticket', authenticate, controller.issueSseTicket);

// One-shot bootstrap of the very first admin. Hidden behind requireBootstrapToken:
// if BOOTSTRAP_TOKEN is unset OR the caller doesn't present the matching token,
// the route responds 404 — invisible to scanners. After this is used once, the
// admin invites every other user via /api/admin/invitations.
router.post('/_bootstrap-admin', requireBootstrapToken, controller.bootstrapAdmin);

// ── Public account-lifecycle endpoints (Marzam Execution Doc §6.1):
// Invitation activation and password reset are intentionally unauthenticated
// — they prove identity through a one-shot signed token, not a session.

router.get('/activate/:token', invitationsController.validateToken);

router.post(
  '/activate/:token',
  validate({
    password: { required: true, type: 'string', minLength: 12, maxLength: 200 },
  }),
  invitationsController.activate,
);

router.post(
  '/password-reset/request',
  validate({
    email: { required: true, type: 'string', format: 'email', maxLength: 200 },
  }),
  invitationsController.requestReset,
);

router.post(
  '/password-reset/:token',
  validate({
    password: { required: true, type: 'string', minLength: 12, maxLength: 200 },
  }),
  invitationsController.completeReset,
);

module.exports = router;
