const service = require('./invitations.service');

async function create(req, res, next) {
  try {
    const { user_id: userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    const out = await service.createInvitation({ userId, createdBy: req.user.id });
    res.status(201).json(out);
  } catch (err) { next(err); }
}

async function bulkCreate(req, res, next) {
  try {
    const userIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : null;
    if (!userIds || !userIds.length) {
      return res.status(400).json({ error: 'user_ids (array) is required' });
    }
    const results = await service.bulkCreateInvitations({ userIds, createdBy: req.user.id });
    const ok = results.filter((r) => r.status === 'ok').length;
    res.status(207).json({ requested: userIds.length, ok, errors: results.length - ok, results });
  } catch (err) { next(err); }
}

async function list(req, res, next) {
  try {
    const rows = await service.listInvitations({
      pendingOnly: String(req.query.pending) === 'true',
      limit: Math.min(Number(req.query.limit) || 100, 500),
    });
    res.json(rows);
  } catch (err) { next(err); }
}

async function listPendingUsers(req, res, next) {
  try {
    const rows = await service.listPendingUsers({
      limit: Math.min(Number(req.query.limit) || 200, 500),
    });
    res.json(rows);
  } catch (err) { next(err); }
}

async function validateToken(req, res, next) {
  try {
    const result = await service.validateActivationToken(req.params.token);
    res.json(result);
  } catch (err) { next(err); }
}

async function activate(req, res, next) {
  try {
    const { password } = req.body || {};
    const user = await service.completeActivation({ token: req.params.token, password });
    // Issue a JWT for the freshly-activated user so the FE skips a login round-trip.
    const authService = require('../auth/auth.service');
    const result = await authService.loginByUserRow(user);
    res.json(result);
  } catch (err) { next(err); }
}

async function requestReset(req, res, next) {
  try {
    await service.requestPasswordReset({ email: req.body?.email });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

async function completeReset(req, res, next) {
  try {
    const { password } = req.body || {};
    const out = await service.completePasswordReset({ token: req.params.token, password });
    res.json(out);
  } catch (err) { next(err); }
}

module.exports = {
  create, bulkCreate, list, listPendingUsers, validateToken, activate,
  requestReset, completeReset,
};
