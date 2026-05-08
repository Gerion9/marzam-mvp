const { Router } = require('express');
const controller = require('./analytics.controller');
const ext = require('./analytics.extensions');
const authenticate = require('../../middleware/auth');

const router = Router();

router.get('/team', authenticate, controller.team);
router.get('/pareto-mix', authenticate, controller.paretoMix);
router.get('/untouched', authenticate, controller.untouched);

router.get('/quotas-blockages', authenticate, ext.quotasBlockages);
router.get('/hierarchy-effectiveness', authenticate, ext.hierarchyEffectiveness);
router.get('/products-margin', authenticate, ext.productsMargin);

module.exports = router;
