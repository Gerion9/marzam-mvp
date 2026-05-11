/**
 * BlackPrint admin — exclusive endpoints (cost summary, geocoding quality,
 * system health, usage metrics, directory readonly). Mounted at /api/blackprint.
 *
 * All endpoints are gated with blackprintOnly: true — even Marzam admin is
 * rejected (403). Endpoints that should be co-readable belong on
 * /api/admin/cockpit/* (anyAdmin), not here.
 */

const { Router } = require('express');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const ctrl = require('./blackprint.controller');

const router = Router();

const blackprintOnly = [authenticate, authorize({ blackprintOnly: true })];

router.get('/cost-summary',      ...blackprintOnly, ctrl.costSummary);
router.get('/geocoding-quality', ...blackprintOnly, ctrl.geocodingQuality);
router.get('/system-health',     ...blackprintOnly, ctrl.systemHealth);
router.get('/usage-metrics',     ...blackprintOnly, ctrl.usageMetrics);
router.get('/directory',         ...blackprintOnly, ctrl.directory);

// Cost simulator (what-if scenarios). GET = preset por defecto; POST = body
// con parámetros custom. Pure compute — no escribe nada.
router.get('/cost-simulate',     ...blackprintOnly, ctrl.simulateCost);
router.post('/cost-simulate',    ...blackprintOnly, ctrl.simulateCost);

module.exports = router;
