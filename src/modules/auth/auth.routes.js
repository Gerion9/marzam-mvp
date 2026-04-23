const { Router } = require('express');
const controller = require('./auth.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const validate = require('../../middleware/validate');

const router = Router();

router.post(
  '/register',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  validate({
    email: { required: true, type: 'string' },
    password: { required: true, type: 'string' },
    full_name: { required: true, type: 'string' },
    role: {
      required: true,
      type: 'string',
      oneOf: ['national_admin', 'regional_manager', 'area_coordinator', 'field_rep', 'manager'],
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

module.exports = router;
