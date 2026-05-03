const { Router } = require('express');
const controller = require('./visitPlans.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

// Anyone with a manager role can create/publish a plan; reps can only consume.
const MANAGER_ROLES = ['director_sucursal', 'gerente_ventas', 'supervisor'];

router.get('/', authenticate, controller.list);
router.get('/assignments', authenticate, controller.myAssignments);
router.get('/:id', authenticate, controller.show);

router.post('/preview', authenticate, authorize({ roles: MANAGER_ROLES }), controller.preview);
router.post('/', authenticate, authorize({ roles: MANAGER_ROLES }), controller.create);
router.patch('/:id/publish', authenticate, authorize({ roles: MANAGER_ROLES }), controller.publish);
router.patch('/:id/archive', authenticate, authorize({ roles: MANAGER_ROLES }), controller.archive);

module.exports = router;
