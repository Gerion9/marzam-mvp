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

module.exports = router;
