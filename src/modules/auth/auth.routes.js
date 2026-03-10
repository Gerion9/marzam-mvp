const { Router } = require('express');
const controller = require('./auth.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const validate = require('../../middleware/validate');

const router = Router();

router.post(
  '/register',
  authenticate,
  authorize('manager'),
  validate({
    email: { required: true, type: 'string' },
    password: { required: true, type: 'string' },
    full_name: { required: true, type: 'string' },
    role: { required: true, type: 'string', oneOf: ['manager', 'field_rep'] },
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

router.get('/users', authenticate, authorize('manager'), controller.listUsers);

router.post(
  '/impersonate',
  authenticate,
  authorize('manager'),
  validate({
    target_user_id: { required: true, type: 'string' },
  }),
  controller.impersonate,
);

router.post('/impersonate/stop', authenticate, controller.stopImpersonation);

module.exports = router;
