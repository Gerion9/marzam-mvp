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
router.post('/preview-full', authenticate, authorize({ roles: MANAGER_ROLES }), controller.previewFull);
router.post('/preview/cost-estimate', authenticate, authorize({ roles: MANAGER_ROLES }), controller.costEstimate);
// Routing sandbox: pure computation, no DB writes — open to any authenticated user (incl. demo).
router.post('/preview-routing', authenticate, controller.previewRouting);
router.post('/', authenticate, authorize({ roles: MANAGER_ROLES }), controller.create);
router.patch('/:id/publish', authenticate, authorize({ roles: MANAGER_ROLES }), controller.publish);
router.patch('/:id/archive', authenticate, authorize({ roles: MANAGER_ROLES }), controller.archive);
router.post('/:id/reassign-stop', authenticate, authorize({ roles: MANAGER_ROLES }), controller.reassignStop);
router.post('/:id/users/:userId/resequence', authenticate, authorize({ roles: MANAGER_ROLES }), controller.resequenceUser);

// Post-mortem: plan-vs-real metrics + per-rep replay for the time scrubber.
router.get('/:id/post-mortem', authenticate, controller.postMortem);
router.get('/:id/post-mortem.csv', authenticate, controller.postMortemCsv);
router.get('/:id/replay/:repId/:day', authenticate, controller.replayRepDay);

// Hard schedule (Marzam Execution Doc §6.2/§6.3): reps stamp actual_start_time
// when they pull up to a pharmacy, and must record a reason if they deviate
// (skip the stop entirely or attend it out of planned order).
router.post('/assignments/:id/start', authenticate, controller.startAssignment);
router.post('/assignments/:id/deviate', authenticate, controller.deviateAssignment);

module.exports = router;
