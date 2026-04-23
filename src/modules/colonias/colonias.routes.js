const { Router } = require('express');
const controller = require('./colonias.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const auditLog = require('../../middleware/auditLog');
const validate = require('../../middleware/validate');

const router = Router();

router.get('/', authenticate, controller.list);
router.get('/geojson', authenticate, controller.geojson);
router.get('/:id', authenticate, controller.getById);

router.patch(
  '/:id/security',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  validate({
    security_level: {
      required: true,
      type: 'string',
      oneOf: ['acceptable', 'caution', 'not_acceptable'],
    },
  }),
  auditLog('colonia.security_updated'),
  controller.updateSecurityLevel,
);

router.post(
  '/batch-security',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager'] }),
  validate({
    ids: { required: true, type: 'array' },
    security_level: {
      required: true,
      type: 'string',
      oneOf: ['acceptable', 'caution', 'not_acceptable'],
    },
  }),
  auditLog('colonia.batch_security_updated'),
  controller.batchUpdateSecurityLevel,
);

module.exports = router;
