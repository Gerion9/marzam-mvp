const { Router } = require('express');
const controller = require('./team.controller');
const authenticate = require('../../middleware/auth');

const router = Router();

router.get('/', authenticate, controller.cascade);
router.get('/:userId', authenticate, controller.member);

module.exports = router;
