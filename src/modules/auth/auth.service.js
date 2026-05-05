const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../config/database');
const config = require('../../config');
const accessDirectory = require('../../services/accessDirectory');
const { isExternalDataMode } = require('../../repositories/runtime');
const { getDataScope } = require('../../middleware/requestContext');
const { computeUserScope, isGlobalRole } = require('../../services/userScope');

const SALT_ROUNDS = 10;

async function buildAuthResult(user, extra = {}) {
  const scope = await computeUserScope(user);
  // Marzam identity tokens — only present in external/virtual mode (the
  // accessDirectory carries them). When loading from the `users` table we
  // copy whatever is on the row so production migrates seamlessly.
  const employee_code = user.employee_code || null;
  const employee_number = user.employee_number || null;
  const branch_code = user.branch_code || null;
  const manager_code = user.manager_code || null;

  // The JWT subject (`id`) is ALWAYS the canonical UUID that lives in the
  // `users` table. When auth comes from the virtual access directory the
  // canonical UUID is `db_user_id` (deterministic uuidv5 of the virtual id).
  // When auth comes from the DB users table the UUID is just `user.id`.
  // `external_id` keeps the legacy/virtual identifier (e.g. `u-dir-001`) so
  // legacy code paths and external systems (BQ sync, demo data) can still
  // resolve it. Backend services should always prefer `req.user.id`.
  const canonicalId = user.db_user_id || user.id;
  const externalId = user.db_user_id ? user.id : (user.external_id || null);

  const token = jwt.sign(
    {
      id: canonicalId,
      external_id: externalId,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      data_scope: user.data_scope || null,
      territory_ids: scope.territoryIds,
      accessible_territory_ids: scope.accessibleTerritoryIds,
      is_global: scope.isGlobal,
      employee_code,
      employee_number,
      branch_code,
      manager_code,
      impersonated_by: extra.impersonated_by || null,
      original_role: extra.original_role || null,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );

  return {
    token,
    user: {
      id: canonicalId,
      external_id: externalId,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      data_scope: user.data_scope || null,
      territory_ids: scope.territoryIds,
      is_global: scope.isGlobal,
      employee_code,
      employee_number,
      branch_code,
      manager_code,
      must_change_password: user.must_change_password === true,
    },
    ...(extra.impersonated_by ? { impersonated_by: extra.impersonated_by } : {}),
  };
}

async function register({ email, password, full_name, role, phone = null, created_by = null, territory_ids = [] }) {
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
    .insert({ email, password_hash, full_name, role, phone, created_by })
    .returning(['id', 'email', 'full_name', 'role', 'is_active', 'phone', 'created_at']);

  if (Array.isArray(territory_ids) && territory_ids.length) {
    const territoriesRepository = require('../../repositories/territoriesRepository');
    for (const tid of territory_ids) {
      await territoriesRepository.assignUserToTerritory({
        userId: user.id,
        territoryId: tid,
        assignedBy: created_by,
      });
    }
  }

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

  db('users')
    .where({ id: user.id })
    .update({ last_login_at: db.fn.now() })
    .catch((err) => console.warn(`[auth] failed to update last_login_at for ${user.id}: ${err.message}`));

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
    // Reshape so the response matches the JWT contract: `id` is the canonical
    // UUID (db_user_id) and `external_id` carries the legacy/virtual id.
    // accessDirectory returns the virtual id as `.id`; we swap them here so
    // any frontend that uses `me().id` for subsequent backend calls gets the
    // same UUID it received in the login response.
    return {
      id: user.db_user_id || user.id,
      external_id: user.db_user_id ? user.id : null,
      email: user.email,
      full_name: user.full_name,
      role: user.role,
      is_active: user.is_active,
      data_scope: user.data_scope,
      employee_code: user.employee_code,
      employee_number: user.employee_number,
      branch_code: user.branch_code,
      manager_code: user.manager_code,
      must_change_password: user.must_change_password,
    };
  }

  const user = await db('users')
    .select('id', 'email', 'full_name', 'role', 'phone', 'must_change_password', 'last_login_at', 'created_at')
    .where({ id: userId })
    .first();
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const territoriesRepository = require('../../repositories/territoriesRepository');
  user.territories = await territoriesRepository.getUserTerritories(userId);
  return user;
}

async function listUsers(filters = {}) {
  if (isExternalDataMode()) {
    return accessDirectory.listUsersByScope(getDataScope());
  }

  const q = db('users')
    .select('id', 'email', 'full_name', 'role', 'is_active', 'phone', 'last_login_at', 'created_at')
    .orderBy('full_name', 'asc');
  if (filters.role) q.where('role', filters.role);
  if (filters.is_active !== undefined) q.where('is_active', filters.is_active);
  if (filters.territory_id) {
    q.whereIn('id', function () {
      this.select('user_id')
        .from('user_territories')
        .where('territory_id', filters.territory_id)
        .whereNull('valid_to');
    });
  }
  if (Array.isArray(filters.accessible_territory_ids)) {
    const ids = filters.accessible_territory_ids;
    if (ids.length === 0) {
      q.whereRaw('1 = 0');
    } else {
      q.whereIn('id', function () {
        this.select('user_id')
          .from('user_territories')
          .whereIn('territory_id', ids)
          .whereNull('valid_to');
      });
    }
  }
  return q;
}

async function updateUser(userId, patch, { actor: _actor = null } = {}) {
  if (isExternalDataMode()) {
    const err = new Error('Update user is disabled in external mode.');
    err.status = 501;
    throw err;
  }
  const allowed = ['full_name', 'role', 'is_active', 'phone', 'email'];
  const data = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }
  if (patch.password) {
    data.password_hash = await bcrypt.hash(patch.password, SALT_ROUNDS);
    data.must_change_password = false;
  }
  if (Object.keys(data).length === 0) {
    const user = await db('users').where({ id: userId }).first();
    return user;
  }
  data.updated_at = db.fn.now();
  const [row] = await db('users').where({ id: userId }).update(data).returning('*');
  return row;
}

async function deactivateUser(userId) {
  if (isExternalDataMode()) {
    const err = new Error('Deactivate user is disabled in external mode.');
    err.status = 501;
    throw err;
  }
  const [row] = await db('users')
    .where({ id: userId })
    .update({ is_active: false, updated_at: db.fn.now() })
    .returning('*');
  return row;
}

async function resetPassword(userId) {
  if (isExternalDataMode()) {
    const err = new Error('Reset password is disabled in external mode.');
    err.status = 501;
    throw err;
  }
  const temp = generateTempPassword();
  const password_hash = await bcrypt.hash(temp, SALT_ROUNDS);
  await db('users')
    .where({ id: userId })
    .update({ password_hash, must_change_password: true, updated_at: db.fn.now() });
  return { temporary_password: temp };
}

function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${out}!`;
}

async function impersonate(managerId, targetUserId) {
  if (!config.impersonation?.enabled) {
    const err = new Error('Impersonation is disabled');
    err.status = 403;
    throw err;
  }

  if (isExternalDataMode()) {
    const manager = accessDirectory.getUserById(managerId);
    if (!manager || !isGlobalRole(manager.role)) {
      const err = new Error('Only administrators can impersonate');
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
  if (!manager || !isGlobalRole(manager.role)) {
    const err = new Error('Only administrators can impersonate');
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

// Bootstrap the very first admin user — Marzam Execution Doc §3 says only
// admin can create users, but the chicken-and-egg of "who creates the first
// admin" is solved here:
//   - Caller must present the env var BOOTSTRAP_TOKEN as a header.
//   - We refuse if any admin user already exists (one-shot in practice).
//   - We refuse in external auth mode (admin is provisioned through the
//     directory provider in that case, not the DB).
async function bootstrapAdmin({ email, password, full_name, providedToken }) {
  if (isExternalDataMode()) {
    const err = new Error('Bootstrap admin is disabled in external auth mode');
    err.status = 501;
    throw err;
  }
  const expected = process.env.BOOTSTRAP_TOKEN;
  if (!expected) {
    const err = new Error('Bootstrap is disabled — BOOTSTRAP_TOKEN env var not set');
    err.status = 501;
    err.code = 'bootstrap_disabled';
    throw err;
  }
  if (!providedToken || providedToken !== expected) {
    const err = new Error('Invalid bootstrap token');
    err.status = 401;
    err.code = 'invalid_bootstrap_token';
    throw err;
  }
  if (!email || !password || !full_name) {
    const err = new Error('email, password, full_name are required');
    err.status = 422;
    throw err;
  }
  if (String(password).length < 12) {
    const err = new Error('Bootstrap admin password must be at least 12 characters');
    err.status = 422;
    err.code = 'bootstrap_password_weak';
    throw err;
  }

  const existingAdmin = await db('users').where({ role: 'admin' }).first();
  if (existingAdmin) {
    const err = new Error('Admin already exists — bootstrap is a one-shot');
    err.status = 409;
    err.code = 'admin_already_exists';
    throw err;
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const [user] = await db('users')
    .insert({
      email,
      password_hash,
      full_name,
      role: 'admin',
      is_active: true,
      must_change_password: false,
    })
    .returning(['id', 'email', 'full_name', 'role', 'is_active', 'created_at']);
  return user;
}

// Issue a JWT for an already-trusted user row (used right after invitation
// activation or password reset, where credentials were just verified through
// a one-shot token rather than email + password).
async function loginByUserRow(user) {
  if (!user || !user.id) {
    const err = new Error('User row missing id');
    err.status = 500;
    throw err;
  }
  db('users')
    .where({ id: user.id })
    .update({ last_login_at: db.fn.now() })
    .catch((err) => console.warn(`[auth] failed to update last_login_at for ${user.id}: ${err.message}`));
  return buildAuthResult(user);
}

module.exports = {
  register,
  login,
  loginByUserRow,
  bootstrapAdmin,
  me,
  listUsers,
  updateUser,
  deactivateUser,
  resetPassword,
  impersonate,
  stopImpersonation,
};
