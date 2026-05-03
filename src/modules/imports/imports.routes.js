const { Router } = require('express');
const controller = require('./imports.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

const ADMIN_ROLES = ['director_sucursal', 'gerente_ventas'];

// Worker tick — Vercel cron hits this. Auth handled inside the controller
// (shared secret OR a director_sucursal token), so we don't gate it with
// `authenticate` here.
router.get('/_worker', controller.workerTick);
router.post('/_worker', controller.workerTick);

router.post(
  '/:kind/upload-url',
  authenticate,
  authorize({ roles: ADMIN_ROLES }),
  controller.uploadUrl,
);

router.post(
  '/:kind',
  authenticate,
  authorize({ roles: ADMIN_ROLES }),
  controller.register,
);

router.get(
  '/',
  authenticate,
  authorize({ roles: ADMIN_ROLES }),
  controller.list,
);

router.get(
  '/:id',
  authenticate,
  authorize({ roles: ADMIN_ROLES }),
  controller.show,
);

module.exports = router;
