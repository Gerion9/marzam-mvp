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

// User CRUD (create/update/deactivate/reset-password) is admin-only per
// Marzam Execution Doc §3. Listing is allowed to all management roles since
// supervisores and gerentes need to see their team rosters.
router.post(
  '/',
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
        'national_admin', 'regional_manager', 'area_coordinator', 'field_rep',
      ],
    },
  }),
  auditLog('user.created'),
  controller.create,
);

router.patch(
  '/:id',
  authenticate,
  authorize({ adminOnly: true }),
  auditLog('user.updated'),
  controller.update,
);

router.delete(
  '/:id',
  authenticate,
  authorize({ adminOnly: true }),
  auditLog('user.deactivated'),
  controller.deactivate,
);

router.post(
  '/:id/reset-password',
  authenticate,
  authorize({ adminOnly: true }),
  auditLog('user.password_reset'),
  controller.resetPassword,
);

// Set / update a rep's home depot. The rep can update their own home; a
// manager can update any rep they manage (canActorManage).
router.put(
  '/:id/home',
  authenticate,
  validate({
    home_lat: { required: true, type: 'number' },
    home_lng: { required: true, type: 'number' },
  }),
  auditLog('user.home_updated'),
  controller.updateHome,
);

module.exports = router;
