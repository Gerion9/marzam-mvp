const { Router } = require('express');
const controller = require('./pharmacies.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const auditLog = require('../../middleware/auditLog');
const validate = require('../../middleware/validate');

const router = Router();

router.get('/', authenticate, controller.list);
router.get('/:id', authenticate, controller.getById);

router.patch(
  '/:id',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  auditLog('pharmacy.updated'),
  controller.update,
);

router.post(
  '/',
  authenticate,
  validate({
    name: { required: true, type: 'string' },
    lat: { required: true, type: 'number' },
    lng: { required: true, type: 'number' },
  }),
  controller.createCandidate,
);

router.post(
  '/find-in-polygon',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  validate({ polygon: { required: true, type: 'object' } }),
  controller.findInsidePolygon,
);

module.exports = router;
