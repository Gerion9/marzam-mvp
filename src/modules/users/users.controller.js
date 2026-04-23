const authService = require('../auth/auth.service');
const { isGlobal } = require('../permissions/permissions');

async function list(req, res, next) {
  try {
    if (req.user.role === 'field_rep') {
      return res.status(403).json({ error: 'Forbidden: field reps cannot list users' });
    }
    const filters = {};
    if (req.query.role) filters.role = req.query.role;
    if (req.query.is_active !== undefined) filters.is_active = req.query.is_active === 'true';
    if (req.query.territory_id) filters.territory_id = req.query.territory_id;
    if (!isGlobal(req.user.role) && !req.user.is_global) {
      filters.accessible_territory_ids = req.user.accessible_territory_ids || [];
    }
    const users = await authService.listUsers(filters);
    res.json(users);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const user = await authService.register({
      email: req.body.email,
      password: req.body.password,
      full_name: req.body.full_name,
      role: req.body.role,
      phone: req.body.phone || null,
      created_by: req.user.id,
      territory_ids: req.body.territory_ids || [],
    });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const updated = await authService.updateUser(req.params.id, req.body, { actor: req.user });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function deactivate(req, res, next) {
  try {
    const row = await authService.deactivateUser(req.params.id);
    res.json(row);
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const result = await authService.resetPassword(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, update, deactivate, resetPassword };
