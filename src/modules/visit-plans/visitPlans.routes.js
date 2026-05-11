const { Router } = require('express');
const controller = require('./visitPlans.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

// Anyone with a manager role can create/publish a plan; reps can only consume.
const MANAGER_ROLES = ['director_sucursal', 'gerente_ventas', 'supervisor'];

router.get('/', authenticate, controller.list);
router.get('/assignments', authenticate, controller.myAssignments);
// Quota probe — usado por el plan-editor para renderizar "Planes hoy: 1/3".
// Cualquier authenticated user puede preguntar por su propia cuota; un rep
// recibirá `null limit / 0 used` (la quota solo aplica si llamara a POST /).
router.get('/quota', authenticate, controller.quota);
router.get('/:id', authenticate, controller.show);

router.post('/preview', authenticate, authorize({ roles: MANAGER_ROLES }), controller.preview);
router.post('/preview-full', authenticate, authorize({ roles: MANAGER_ROLES }), controller.previewFull);
router.post('/preview/cost-estimate', authenticate, authorize({ roles: MANAGER_ROLES }), controller.costEstimate);
// Cambio 1 — National estimate without spending Google Routes API.
// Useful when the user wants to see how a plan would distribute across multiple
// Entidades Federativas but doesn't want to commit (and pay for) a real plan.
router.post('/preview/national-estimate', authenticate, authorize({ roles: MANAGER_ROLES }), controller.nationalEstimate);
// Routing sandbox: pure computation, no DB writes — open to any authenticated user (incl. demo).
router.post('/preview-routing', authenticate, controller.previewRouting);
router.post('/', authenticate, authorize({ roles: MANAGER_ROLES }), controller.create);
router.patch('/:id/publish', authenticate, authorize({ roles: MANAGER_ROLES }), controller.publish);
router.patch('/:id/archive', authenticate, authorize({ roles: MANAGER_ROLES }), controller.archive);
router.post('/:id/reassign-stop', authenticate, authorize({ roles: MANAGER_ROLES }), controller.reassignStop);
router.post('/:id/users/:userId/resequence', authenticate, authorize({ roles: MANAGER_ROLES }), controller.resequenceUser);

// Intraday reoptimizer: rep breakdown / urgent insert / cap-exceeded recovery.
// Only available on PUBLISHED plans — never mutates draft plans (those go through
// the normal generate flow). See migrations 074, 075 + intradayReoptimizer.js.
router.post('/:id/reoptimize-day', authenticate, authorize({ roles: MANAGER_ROLES }), controller.reoptimizeDay);
router.get('/:id/reoptimizations', authenticate, controller.listReoptimizations);

// Global replan with lineage: produces a new visit_plans row with parent_plan_id
// set, version incremented, and replan_reason recorded. Archives the parent in
// the same transaction. See replanWithHistory.js + migration 086.
router.post('/:id/replan', authenticate, authorize({ roles: MANAGER_ROLES }), controller.replan);

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
