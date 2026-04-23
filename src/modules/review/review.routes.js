const { Router } = require('express');
const controller = require('./review.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const auditLog = require('../../middleware/auditLog');
const validate = require('../../middleware/validate');

const router = Router();

router.get('/', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.list);
router.get('/pending-count', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.pendingCount);

router.patch(
  '/:id/resolve',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  validate({
    decision: { required: true, type: 'string', oneOf: ['approved', 'rejected'] },
  }),
  auditLog('review.resolved'),
  controller.resolve,
);

router.post(
  '/batch-resolve',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  validate({
    ids: { required: true, type: 'array' },
    decision: { required: true, type: 'string', oneOf: ['approved', 'rejected'] },
  }),
  auditLog('review.batch_resolved'),
  controller.batchResolve,
);

module.exports = router;
