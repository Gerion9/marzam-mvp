const { Router } = require('express');
const controller = require('./review.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const auditLog = require('../../middleware/auditLog');
const validate = require('../../middleware/validate');

const router = Router();

router.get('/', authenticate, authorize('manager'), controller.list);
router.get('/pending-count', authenticate, authorize('manager'), controller.pendingCount);

router.patch(
  '/:id/resolve',
  authenticate,
  authorize('manager'),
  validate({
    decision: { required: true, type: 'string', oneOf: ['approved', 'rejected'] },
  }),
  auditLog('review.resolved'),
  controller.resolve,
);

router.post(
  '/batch-resolve',
  authenticate,
  authorize('manager'),
  validate({
    ids: { required: true, type: 'array' },
    decision: { required: true, type: 'string', oneOf: ['approved', 'rejected'] },
  }),
  auditLog('review.batch_resolved'),
  controller.batchResolve,
);

module.exports = router;
