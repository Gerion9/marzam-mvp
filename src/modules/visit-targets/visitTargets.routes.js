const { Router } = require('express');
const controller = require('./visitTargets.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

router.get('/', authenticate, controller.list);
router.get('/expanded', authenticate, controller.listExpanded);
router.get('/resolve', authenticate, controller.resolve);
router.get('/overrides/:userId', authenticate, controller.listOverrides);

// Editing visit targets (and per-user overrides) is admin-only per
// Marzam Execution Doc §3 — these drive reps' daily quotas and KPI bars.
router.post('/', authenticate, authorize({ adminOnly: true }), controller.upsert);
router.post('/bulk', authenticate, authorize({ adminOnly: true }), controller.bulkUpsert);
router.post('/overrides', authenticate, authorize({ adminOnly: true }), controller.override);

module.exports = router;
