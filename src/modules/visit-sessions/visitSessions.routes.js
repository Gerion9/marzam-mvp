const { Router } = require('express');
const controller = require('./visitSessions.controller');
const authenticate = require('../../middleware/auth');

const router = Router();

router.post('/start', authenticate, controller.start);
router.patch('/:id/end', authenticate, controller.end);
router.get('/active/:userId', authenticate, controller.active);
router.get('/', authenticate, controller.list);

module.exports = router;
