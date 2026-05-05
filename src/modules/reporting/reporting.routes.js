const { Router } = require('express');
const controller = require('./reporting.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

router.get('/dashboard', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.dashboard);
router.get('/reps', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.repProductivity);
router.get('/coverage', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.coverageByMunicipality);
router.get('/assignments', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.assignmentProgress);
router.get('/export/pharmacies', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.exportPharmacies);
router.get('/export/rep-route/:repId', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.exportRepRoute);
router.get('/export/all-rep-routes', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.exportAllRepRoutes);
router.get('/visits', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.visitDetail);
router.get('/flotilla', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.flotillaSummary);
router.post('/refresh', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.refreshViews);

// Marzam Execution Doc §10 KPI set — usable by all management roles + admin
// (admin always passes via expandAllowed). Reps see their own data through
// the existing endpoints; these are aggregate/management-side reports.
const MGMT = ['director_sucursal', 'gerente_ventas', 'supervisor', 'national_admin', 'regional_manager', 'area_coordinator'];
router.get('/kpi/route-adherence',  authenticate, authorize({ roles: MGMT }), controller.routeAdherence);
router.get('/kpi/visit-duration',   authenticate, authorize({ roles: MGMT }), controller.visitDuration);
router.get('/kpi/prospect-funnel',  authenticate, authorize({ roles: MGMT }), controller.prospectFunnel);
router.get('/kpi/sales-vs-target',  authenticate, authorize({ roles: MGMT }), controller.salesVsTarget);
router.get('/kpi/routes-on-time',   authenticate, authorize({ roles: MGMT }), controller.routesOnTime);

module.exports = router;
