const { Router } = require('express');
const controller = require('./territories.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const validate = require('../../middleware/validate');

const router = Router();

router.get('/', authenticate, controller.listTree);
router.get('/flat', authenticate, controller.listFlat);
router.get('/:id', authenticate, controller.getById);
router.get('/:id/users', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.listUsers);

router.post(
  '/',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  validate({
    level: { required: true, type: 'string', oneOf: ['national', 'regional', 'municipal', 'zone'] },
    name: { required: true, type: 'string' },
  }),
  controller.create,
);

router.patch(
  '/:id',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  controller.update,
);

router.post(
  '/:id/users',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  validate({ user_id: { required: true, type: 'string' } }),
  controller.assignUser,
);

router.delete(
  '/:id/users/:userId',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  controller.revokeUser,
);

module.exports = router;
