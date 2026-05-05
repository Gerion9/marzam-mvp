const { Router } = require('express');
const controller = require('./auth.controller');
const invitationsController = require('../invitations/invitations.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const validate = require('../../middleware/validate');

const router = Router();

// User CRUD is admin-only per Marzam Execution Doc §3.
router.post(
  '/register',
  authenticate,
  authorize({ adminOnly: true }),
  validate({
    email: { required: true, type: 'string' },
    password: { required: true, type: 'string' },
    full_name: { required: true, type: 'string' },
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
    email: { required: true, type: 'string' },
    password: { required: true, type: 'string' },
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
    target_user_id: { required: true, type: 'string' },
  }),
  controller.impersonate,
);

router.post('/impersonate/stop', authenticate, controller.stopImpersonation);

// One-shot bootstrap of the very first admin (no auth — gated by env var
// BOOTSTRAP_TOKEN passed as `X-Bootstrap-Token` header). Refuses if any
// admin already exists. After this is used once, the admin invites every
// other user via /api/admin/invitations.
router.post('/_bootstrap-admin', controller.bootstrapAdmin);

// ── Public account-lifecycle endpoints (Marzam Execution Doc §6.1):
// Invitation activation and password reset are intentionally unauthenticated
// — they prove identity through a one-shot signed token, not a session.

router.get('/activate/:token', invitationsController.validateToken);

router.post(
  '/activate/:token',
  validate({
    password: { required: true, type: 'string' },
  }),
  invitationsController.activate,
);

router.post(
  '/password-reset/request',
  validate({
    email: { required: true, type: 'string' },
  }),
  invitationsController.requestReset,
);

router.post(
  '/password-reset/:token',
  validate({
    password: { required: true, type: 'string' },
  }),
  invitationsController.completeReset,
);

module.exports = router;
