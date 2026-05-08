const { Router } = require('express');
const controller = require('./alerts.controller');
const authenticate = require('../../middleware/auth');
const validate = require('../../middleware/validate');

const router = Router();

// Cron tick — Vercel cron hits this (auth handled inside controller via
// CRON_SECRET header or token), so no `authenticate` here.
router.get('/_evaluate', controller.evaluateTick);
router.post('/_evaluate', controller.evaluateTick);

// User-facing alert feed (own + subtree) and resolve.
router.get('/feed', authenticate, controller.feed);
router.post('/:id/resolve', authenticate, controller.resolve);

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
