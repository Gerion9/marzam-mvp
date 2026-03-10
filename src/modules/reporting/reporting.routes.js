const { Router } = require('express');
const controller = require('./reporting.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

router.get('/dashboard', authenticate, authorize('manager'), controller.dashboard);
router.get('/reps', authenticate, authorize('manager'), controller.repProductivity);
router.get('/coverage', authenticate, authorize('manager'), controller.coverageByMunicipality);
router.get('/assignments', authenticate, authorize('manager'), controller.assignmentProgress);
router.get('/export/pharmacies', authenticate, authorize('manager'), controller.exportPharmacies);
router.post('/refresh', authenticate, authorize('manager'), controller.refreshViews);

module.exports = router;
