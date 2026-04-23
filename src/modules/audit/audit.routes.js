const { Router } = require('express');
const controller = require('./audit.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');

const router = Router();

router.get('/', authenticate, authorize({ roles: ['national_admin', 'regional_manager'] }), controller.list);
router.get('/:entityType/:entityId', authenticate, authorize({ roles: ['national_admin', 'regional_manager'] }), controller.getByEntity);

module.exports = router;
