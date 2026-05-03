const { Router } = require('express');
const controller = require('./visitTargets.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

const MANAGER_ROLES = ['director_sucursal', 'gerente_ventas', 'supervisor'];

router.get('/', authenticate, controller.list);
router.get('/resolve', authenticate, controller.resolve);
router.get('/overrides/:userId', authenticate, controller.listOverrides);

router.post('/', authenticate, authorize({ roles: MANAGER_ROLES }), controller.upsert);
router.post('/overrides', authenticate, authorize({ roles: MANAGER_ROLES }), controller.override);

module.exports = router;
