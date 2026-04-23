const { Router } = require('express');

const controller = require('./verifications.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

router.get('/pharmacy/:pharmacyId', authenticate, controller.listByPharmacy);
router.get('/evidence', authenticate, controller.listEvidence);
router.get('/reps/:repId/summary', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), controller.getRepSummary);

module.exports = router;
