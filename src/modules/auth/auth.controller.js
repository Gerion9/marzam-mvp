const authService = require('./auth.service');
const accessDirectory = require('../../services/accessDirectory');

async function register(req, res, next) {
  try {
    const user = await authService.register(req.body);
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
}

async function bootstrapAdmin(req, res, next) {
  try {
    const providedToken = req.headers['x-bootstrap-token']
      || req.body?.bootstrap_token
      || req.query?.token;
    const user = await authService.bootstrapAdmin({
      email: req.body?.email,
      password: req.body?.password,
      full_name: req.body?.full_name,
      providedToken,
    });
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
    const result = await authService.impersonate(
      req.user.id,
      accessDirectory.toCanonicalId(req.body.target_user_id),
    );
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

module.exports = { register, bootstrapAdmin, login, me, listUsers, impersonate, stopImpersonation };
