const { Router } = require('express');
const controller = require('./team.controller');
const authenticate = require('../../middleware/auth');

const router = Router();

router.get('/', authenticate, controller.cascade);
// Literal paths MUST be registered before `/:userId` so Express matches them
// first (otherwise the segment is parsed as a UUID userId and the SQL fails).
router.get('/descendants', authenticate, controller.descendants);
router.get('/cascade', authenticate, controller.cascade);
router.get('/:userId', authenticate, controller.member);

module.exports = router;
