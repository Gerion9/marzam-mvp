const authService = require('./auth.service');

async function register(req, res, next) {
  try {
    const user = await authService.register(req.body);
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const result = await authService.login(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await authService.me(req.user.id);
    const response = { ...user };
    if (req.user.impersonated_by) {
      response.impersonated_by = req.user.impersonated_by;
      response.original_role = req.user.original_role;
    }
    res.json(response);
  } catch (err) {
    next(err);
  }
}

async function listUsers(req, res, next) {
  try {
    const users = await authService.listUsers();
    res.json(users);
  } catch (err) {
    next(err);
  }
}

async function impersonate(req, res, next) {
  try {
    const result = await authService.impersonate(req.user.id, req.body.target_user_id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function stopImpersonation(req, res, next) {
  try {
    if (!req.user.impersonated_by) {
      return res.status(400).json({ error: 'Not currently impersonating' });
    }
    const result = await authService.stopImpersonation(req.user.impersonated_by);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, me, listUsers, impersonate, stopImpersonation };
