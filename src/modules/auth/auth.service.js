const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../config/database');
const config = require('../../config');
const accessDirectory = require('../../services/accessDirectory');
const { isExternalDataMode } = require('../../repositories/runtime');
const { getDataScope } = require('../../middleware/requestContext');

const SALT_ROUNDS = 10;

function buildAuthResult(user, extra = {}) {
  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      data_scope: user.data_scope || null,
      impersonated_by: extra.impersonated_by || null,
      original_role: extra.original_role || null,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );

  return {
    token,
    user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, data_scope: user.data_scope || null },
    ...(extra.impersonated_by ? { impersonated_by: extra.impersonated_by } : {}),
  };
}

async function register({ email, password, full_name, role }) {
  if (isExternalDataMode()) {
    const err = new Error('Register is disabled in external mode. Use AUTH_DIRECTORY settings.');
    err.status = 501;
    throw err;
  }

  const existing = await db('users').where({ email }).first();
  if (existing) {
    const err = new Error('Email already registered');
    err.status = 409;
    throw err;
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const [user] = await db('users')
    .insert({ email, password_hash, full_name, role })
    .returning(['id', 'email', 'full_name', 'role', 'created_at']);

  return user;
}

async function login({ email, password }) {
  if (isExternalDataMode()) {
    const user = accessDirectory.authenticate(email, password);
    return buildAuthResult(user);
  }

  const user = await db('users').where({ email, is_active: true }).first();
  if (!user) {
    const err = new Error('Invalid credentials');
    err.status = 401;
    throw err;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    const err = new Error('Invalid credentials');
    err.status = 401;
    throw err;
  }

  return buildAuthResult(user);
}

async function me(userId) {
  if (isExternalDataMode()) {
    const user = accessDirectory.getUserById(userId);
    if (!user) {
      const err = new Error('User not found');
      err.status = 404;
      throw err;
    }
    return user;
  }

  const user = await db('users')
    .select('id', 'email', 'full_name', 'role', 'created_at')
    .where({ id: userId })
    .first();
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  return user;
}

async function listUsers() {
  if (isExternalDataMode()) {
    return accessDirectory.listUsersByScope(getDataScope());
  }

  return db('users')
    .select('id', 'email', 'full_name', 'role', 'is_active', 'created_at')
    .orderBy('full_name', 'asc');
}

async function impersonate(managerId, targetUserId) {
  if (!config.impersonation?.enabled) {
    const err = new Error('Impersonation is disabled');
    err.status = 403;
    throw err;
  }

  if (isExternalDataMode()) {
    const manager = accessDirectory.getUserById(managerId);
    if (!manager || manager.role !== 'manager') {
      const err = new Error('Only managers can impersonate');
      err.status = 403;
      throw err;
    }
    const target = accessDirectory.getUserById(targetUserId);
    if (!target) {
      const err = new Error('Target user not found or inactive');
      err.status = 404;
      throw err;
    }
    if (target.id === managerId) {
      const err = new Error('Cannot impersonate yourself');
      err.status = 400;
      throw err;
    }
    if ((manager.data_scope || null) !== (target.data_scope || null)) {
      const err = new Error('Cannot impersonate users from a different data scope');
      err.status = 403;
      throw err;
    }
    return buildAuthResult(target, {
      impersonated_by: managerId,
      original_role: manager.role,
    });
  }

  const manager = await db('users').where({ id: managerId, is_active: true }).first();
  if (!manager || manager.role !== 'manager') {
    const err = new Error('Only managers can impersonate');
    err.status = 403;
    throw err;
  }

  const target = await db('users').where({ id: targetUserId, is_active: true }).first();
  if (!target) {
    const err = new Error('Target user not found or inactive');
    err.status = 404;
    throw err;
  }

  if (target.id === managerId) {
    const err = new Error('Cannot impersonate yourself');
    err.status = 400;
    throw err;
  }

  return buildAuthResult(target, {
    impersonated_by: managerId,
    original_role: manager.role,
  });
}

async function stopImpersonation(managerId) {
  if (isExternalDataMode()) {
    const manager = accessDirectory.getUserById(managerId);
    if (!manager) {
      const err = new Error('User not found');
      err.status = 404;
      throw err;
    }
    return buildAuthResult(manager);
  }

  const manager = await db('users').where({ id: managerId, is_active: true }).first();
  if (!manager) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  return buildAuthResult(manager);
}

module.exports = { register, login, me, listUsers, impersonate, stopImpersonation };
