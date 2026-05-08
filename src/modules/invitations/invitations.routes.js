const { Router } = require('express');
const controller = require('./invitations.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const auditLog = require('../../middleware/auditLog');

const router = Router();

// Admin-only: minting + listing + bulk invitations is exclusive to admin per
// Marzam Execution Doc §3 ("create/delete users").
router.post('/', authenticate, authorize({ adminOnly: true }), auditLog('invitation.created'), controller.create);
router.post('/bulk', authenticate, authorize({ adminOnly: true }), auditLog('invitation.bulk_created'), controller.bulkCreate);
router.get('/', authenticate, authorize({ adminOnly: true }), controller.list);

// Convenience for the post-roster-import workflow: list users that are ready
// to be invited (have real email, never logged in, no pending invite).
router.get('/pending-users', authenticate, authorize({ adminOnly: true }), controller.listPendingUsers);

module.exports = router;
