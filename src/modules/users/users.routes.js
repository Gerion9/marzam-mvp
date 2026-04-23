const { Router } = require('express');
const controller = require('./users.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const validate = require('../../middleware/validate');
const auditLog = require('../../middleware/auditLog');

const router = Router();

router.get(
  '/',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  controller.list,
);

router.post(
  '/',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  validate({
    email: { required: true, type: 'string' },
    password: { required: true, type: 'string' },
    full_name: { required: true, type: 'string' },
    role: {
      required: true,
      type: 'string',
      oneOf: ['national_admin', 'regional_manager', 'area_coordinator', 'field_rep'],
    },
  }),
  auditLog('user.created'),
  controller.create,
);

router.patch(
  '/:id',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  auditLog('user.updated'),
  controller.update,
);

router.delete(
  '/:id',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  auditLog('user.deactivated'),
  controller.deactivate,
);

router.post(
  '/:id/reset-password',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  auditLog('user.password_reset'),
  controller.resetPassword,
);

module.exports = router;
