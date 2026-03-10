const { Router } = require('express');
const controller = require('./assignments.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const auditLog = require('../../middleware/auditLog');
const validate = require('../../middleware/validate');

const router = Router();

router.get('/', authenticate, controller.list);
router.get('/:id', authenticate, controller.getById);

router.post(
  '/',
  authenticate,
  authorize('manager'),
  validate({
    pharmacy_ids: { required: true },
    campaign_objective: { required: true, type: 'string' },
  }),
  auditLog('assignment.created'),
  controller.create,
);

router.post(
  '/distribute',
  authenticate,
  authorize('manager'),
  validate({
    campaign_objective: { required: true, type: 'string' },
    municipality: { type: 'string' },
    rep_ids: { type: 'array' },
    priority: { type: 'string', oneOf: ['low', 'normal', 'high', 'urgent'] },
    due_date: { type: 'string' },
    wave_id: { type: 'string' },
    max_pharmacies_per_rep: { type: 'number' },
  }),
  auditLog('assignment.wave_created'),
  controller.distributeWave,
);

router.patch(
  '/:id/status',
  authenticate,
  validate({
    status: {
      required: true,
      type: 'string',
      oneOf: ['unassigned', 'assigned', 'in_progress', 'completed'],
    },
  }),
  auditLog('assignment.status_changed'),
  controller.updateStatus,
);

router.patch(
  '/:id',
  authenticate,
  authorize('manager'),
  auditLog('assignment.updated'),
  controller.reassign,
);

router.post(
  '/check-overlap',
  authenticate,
  authorize('manager'),
  validate({ polygon: { required: true, type: 'object' } }),
  controller.checkOverlap,
);

module.exports = router;
