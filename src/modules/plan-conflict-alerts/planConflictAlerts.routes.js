const { Router } = require('express');
const controller = require('./planConflictAlerts.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();
const MANAGER_ROLES = ['director_sucursal', 'gerente_ventas', 'supervisor'];

// List + show — readable by any authenticated manager.
router.get('/', authenticate, controller.list);
router.get('/:id', authenticate, controller.show);

// Acknowledge / dismiss — supervisor+.
router.post('/:id/acknowledge', authenticate, authorize({ roles: MANAGER_ROLES }), controller.acknowledge);
router.post('/:id/dismiss', authenticate, authorize({ roles: MANAGER_ROLES }), controller.dismiss);

// Trigger replan of "resto del mes" — supervisor+.
router.post('/:id/reoptimize', authenticate, authorize({ roles: MANAGER_ROLES }), controller.reoptimize);

module.exports = router;
