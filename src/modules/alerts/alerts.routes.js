const { Router } = require('express');
const controller = require('./alerts.controller');
const authenticate = require('../../middleware/auth');
const validate = require('../../middleware/validate');

const router = Router();

router.get('/dismissals', authenticate, controller.listDismissals);

router.post(
  '/dismissals',
  authenticate,
  validate({
    alert_key: { required: true, type: 'string' },
    expires_at: { type: 'string' },
  }),
  controller.dismiss,
);

router.delete('/dismissals/:key', authenticate, controller.undismiss);

module.exports = router;
