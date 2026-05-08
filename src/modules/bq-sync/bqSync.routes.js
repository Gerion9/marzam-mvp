const { Router } = require('express');
const controller = require('./bqSync.controller');

const router = Router();

router.get('/_worker', controller.workerTick);
router.post('/_worker', controller.workerTick);

// Daily cron: purge route_matrix_cache entries beyond 23 days (Google ToS).
router.get('/_purge-route-cache', controller.purgeRouteCacheTick);
router.post('/_purge-route-cache', controller.purgeRouteCacheTick);

module.exports = router;
