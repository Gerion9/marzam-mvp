const { Router } = require('express');
const controller = require('./tracking.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const validate = require('../../middleware/validate');

const router = Router();

// Pings: any user with a tracked field role can post their position.
// Supervisors/gerentes/director are accepted so they appear as map pins when
// they are in the field — the live-ops view differentiates pin styling by
// role. Checkins remain rep-only because Marzam Execution Doc §6 ties visit
// evidence to the representante role.
const FIELD_ROLES = ['field_rep', 'supervisor', 'gerente_ventas', 'director_sucursal'];

router.post(
  '/ping',
  authenticate,
  authorize({ roles: FIELD_ROLES }),
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
  '/ping-batch',
  authenticate,
  authorize({ roles: FIELD_ROLES }),
  controller.recordPingBatch,
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
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  controller.getCheckins,
);

router.get(
  '/breadcrumbs/:repId',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  controller.getBreadcrumbs,
);

router.get(
  '/positions',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  controller.getLatestPositions,
);

module.exports = router;
