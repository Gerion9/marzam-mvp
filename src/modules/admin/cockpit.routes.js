/**
 * Admin Cockpit — read-only analytics endpoints for the dedicated /admin
 * dashboard. Mounted at /api/admin/cockpit (see src/app.js).
 *
 * All endpoints require admin role. Director_sucursal is intentionally
 * excluded in this phase — they continue to use the shared /app shell.
 */

const { Router } = require('express');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const ctrl = require('./cockpit.controller');

const router = Router();

const adminOnly = [authenticate, authorize({ adminOnly: true })];

router.get('/hero',             ...adminOnly, ctrl.hero);
router.get('/trend',            ...adminOnly, ctrl.trend);
router.get('/coverage-heatmap', ...adminOnly, ctrl.coverageHeatmap);
router.get('/hierarchy',        ...adminOnly, ctrl.hierarchy);
router.get('/operations',       ...adminOnly, ctrl.operations);
router.get('/people',           ...adminOnly, ctrl.people);
router.get('/commercial',       ...adminOnly, ctrl.commercial);
router.get('/onboarding',       ...adminOnly, ctrl.onboarding);
router.get('/data-quality',     ...adminOnly, ctrl.dataQuality);
router.get('/system',           ...adminOnly, ctrl.system);
router.get('/audit-feed',       ...adminOnly, ctrl.auditFeed);
router.get('/anomalies',        ...adminOnly, ctrl.anomalies);

module.exports = router;
