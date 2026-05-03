const { Router } = require('express');
const controller = require('./bqSync.controller');

const router = Router();

router.get('/_worker', controller.workerTick);
router.post('/_worker', controller.workerTick);

module.exports = router;
