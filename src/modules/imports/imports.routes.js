const { Router } = require('express');
const controller = require('./imports.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

// Worker tick — Vercel cron hits this. Auth handled inside the controller
// (shared secret OR an authenticated admin/director token), so we don't gate
// it with `authenticate` here.
router.get('/_worker', controller.workerTick);
router.post('/_worker', controller.workerTick);

// Imports change A/B/C classification + creditos + sales targets at scale →
// admin-only per Marzam Execution Doc §3. Listing past jobs is also gated to
// keep audit trail visibility scoped.
router.post(
  '/:kind/upload-url',
  authenticate,
  authorize({ adminOnly: true }),
  controller.uploadUrl,
);

router.post(
  '/:kind',
  authenticate,
  authorize({ adminOnly: true }),
  controller.register,
);

router.get(
  '/',
  authenticate,
  authorize({ adminOnly: true }),
  controller.list,
);

router.get(
  '/:id',
  authenticate,
  authorize({ adminOnly: true }),
  controller.show,
);

module.exports = router;
