const { Router } = require('express');
const controller = require('./tracking.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const validate = require('../../middleware/validate');

const router = Router();

router.post(
  '/ping',
  authenticate,
  authorize('field_rep'),
  validate({
    lat: { required: true, type: 'number' },
    lng: { required: true, type: 'number' },
    assignment_id: { type: 'string' },
    verification_id: { type: 'string' },
    accuracy_meters: { type: 'number' },
  }),
  controller.recordPing,
);

router.post(
  '/checkin',
  authenticate,
  authorize('field_rep'),
  validate({
    pharmacy_id: { required: true, type: 'string' },
    lat: { required: true, type: 'number' },
    lng: { required: true, type: 'number' },
  }),
  controller.checkin,
);

router.get(
  '/checkins/:repId',
  authenticate,
  authorize('manager'),
  controller.getCheckins,
);

router.get(
  '/breadcrumbs/:repId',
  authenticate,
  authorize('manager'),
  controller.getBreadcrumbs,
);

router.get(
  '/positions',
  authenticate,
  authorize('manager'),
  controller.getLatestPositions,
);

module.exports = router;
