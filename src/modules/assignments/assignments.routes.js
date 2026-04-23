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
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
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
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  validate({
    campaign_objective: { required: true, type: 'string' },
    municipality: { type: 'string' },
    rep_ids: { type: 'array' },
    priority: { type: 'string', oneOf: ['low', 'normal', 'high', 'urgent'] },
    due_date: { type: 'string' },
    wave_id: { type: 'string' },
    max_pharmacies_per_rep: { type: 'number' },
    dry_run: { type: 'boolean' },
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
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  validate({
    rep_id: { type: 'string' },
    campaign_objective: { type: 'string' },
    priority: { type: 'string', oneOf: ['low', 'normal', 'high', 'urgent'] },
    due_date: { type: 'string' },
    visit_goal: { type: 'number' },
  }),
  auditLog('assignment.updated'),
  controller.reassign,
);

router.post(
  '/check-overlap',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  validate({ polygon: { required: true, type: 'object' } }),
  controller.checkOverlap,
);

router.patch(
  '/:id/reorder',
  authenticate,
  validate({
    stop_order: { required: true, type: 'array' },
  }),
  auditLog('assignment.reordered'),
  controller.reorderStops,
);

router.post(
  '/:id/stops',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  validate({ pharmacy_ids: { required: true, type: 'array' } }),
  auditLog('assignment.stops_added'),
  controller.addStops,
);

router.delete(
  '/:id/stops/:stopId',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  auditLog('assignment.stop_removed'),
  controller.removeStop,
);

router.post(
  '/reset',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  controller.resetAll,
);

module.exports = router;
