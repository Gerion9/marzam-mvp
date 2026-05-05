const { Router } = require('express');
const controller = require('./team.controller');
const authenticate = require('../../middleware/auth');

const router = Router();

router.get('/', authenticate, controller.cascade);
// `descendants` MUST be registered before `/:userId` so Express matches the
// literal path first (otherwise "descendants" is parsed as a UUID userId).
router.get('/descendants', authenticate, controller.descendants);
router.get('/:userId', authenticate, controller.member);

module.exports = router;
