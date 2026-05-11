/**
 * Admin Cockpit — read-only analytics endpoints for the dedicated /admin
 * dashboard. Mounted at /api/admin/cockpit (see src/app.js).
 *
 * Gate: anyAdmin — both Marzam admin (the client) and blackprint_admin (the
 * platform team) may read these analytics. Director_sucursal is intentionally
 * excluded in this phase — they continue to use the shared /app shell.
 *
 * BlackPrint reads via /blackprint dashboard (which composes these endpoints
 * with /api/blackprint/* exclusive ones). The /admin dashboard remains the
 * Marzam client view.
 */

const { Router } = require('express');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const ctrl = require('./cockpit.controller');

const router = Router();

const anyAdminRO = [authenticate, authorize({ anyAdmin: true })];

// [P10] Routes API matrix cache statistics — exposes hit rate, total pairs,
// API call count for the admin cockpit so we can tune cache TTL with data.
router.get('/routes-matrix-stats', ...anyAdminRO, (_req, res) => {
  // eslint-disable-next-line global-require
  const routesMatrix = require('../../services/routesMatrix');
  res.json(routesMatrix.getStats());
});

router.get('/hero',             ...anyAdminRO, ctrl.hero);
router.get('/trend',            ...anyAdminRO, ctrl.trend);
router.get('/coverage-heatmap', ...anyAdminRO, ctrl.coverageHeatmap);
router.get('/hierarchy',        ...anyAdminRO, ctrl.hierarchy);
router.get('/operations',       ...anyAdminRO, ctrl.operations);
router.get('/people',           ...anyAdminRO, ctrl.people);
router.get('/commercial',       ...anyAdminRO, ctrl.commercial);
router.get('/onboarding',       ...anyAdminRO, ctrl.onboarding);
router.get('/data-quality',     ...anyAdminRO, ctrl.dataQuality);
router.get('/system',           ...anyAdminRO, ctrl.system);
router.get('/audit-feed',       ...anyAdminRO, ctrl.auditFeed);
router.get('/anomalies',        ...anyAdminRO, ctrl.anomalies);

module.exports = router;
