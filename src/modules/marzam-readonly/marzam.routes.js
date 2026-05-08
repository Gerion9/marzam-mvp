/**
 * Marzam read-only API.
 *
 * Read-through projection of the four source tables (integration/staging)
 * shaped like the would-be `users` / `branches` / `marzam_clients` rows.
 * Exists because we cannot create the destination tables yet
 * (see docs/ROADMAP-PRODUCTION.md).
 *
 * Routes:
 *   GET /api/marzam/diagnostics              public — counts and source health
 *   GET /api/marzam/representatives          auth   — scoped list of reps/sup/gerentes
 *   GET /api/marzam/me                       auth   — single employee, by JWT employee_code
 *   GET /api/marzam/branches                 auth   — gerencia rollup
 *   GET /api/marzam/clients?limit=200        auth   — clients filtered by user role
 *   POST /api/marzam/_admin/clear-cache      auth + director_sucursal
 */

const express = require('express');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const ctrl = require('./marzam.controller');

const router = express.Router();

router.get('/diagnostics', ctrl.getDiagnostics);

router.get('/representatives', authenticate, ctrl.listRepresentatives);
router.get('/me', authenticate, ctrl.getMyProfile);
router.get('/branches', authenticate, ctrl.listBranches);
router.get('/clients', authenticate, ctrl.listClients);
router.get('/universe', authenticate, ctrl.listUniverse);
router.get('/sales-summary', authenticate, ctrl.salesSummary);

router.post(
  '/_admin/clear-cache',
  authenticate,
  authorize('director_sucursal'),
  ctrl.clearCache,
);

module.exports = router;
