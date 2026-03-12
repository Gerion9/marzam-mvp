const config = require('../config');
const { v5: uuidv5 } = require('uuid');

const DEVICE_USER_NAMESPACE = '74e8d182-c5ba-4f5c-bffe-7549315401a3';

function pad(num) {
  return String(num).padStart(3, '0');
}

function normalizeCustomUser(user, index) {
  return {
    id: String(user.id || `custom${pad(index + 1)}`),
    email: String(user.email || '').trim().toLowerCase(),
    password: String(user.password || config.authDirectory.repDefaultPassword),
    full_name: String(user.full_name || user.name || `Custom User ${index + 1}`),
    role: user.role === 'manager' ? 'manager' : 'field_rep',
    is_active: user.is_active !== false,
    db_user_id: user.db_user_id || uuidv5(String(user.id || user.email || `custom${index + 1}`), DEVICE_USER_NAMESPACE),
    data_scope: user.data_scope || null,
  };
}

function buildVirtualUsers() {
  const manager = {
    id: config.authDirectory.managerId,
    email: config.authDirectory.managerEmail.trim().toLowerCase(),
    password: config.authDirectory.managerPassword,
    full_name: config.authDirectory.managerName,
    role: 'manager',
    is_active: true,
    db_user_id: uuidv5(config.authDirectory.managerId, DEVICE_USER_NAMESPACE),
    data_scope: null,
  };

  const reps = Array.from({ length: config.authDirectory.repCount }, (_, index) => {
    const suffix = pad(index + 1);
    const separator = config.authDirectory.repNamePrefix.endsWith(' ') ? '' : ' ';
    return {
      id: `${config.authDirectory.repIdPrefix}${suffix}`,
      email: `${config.authDirectory.repEmailPrefix}${suffix}@${config.authDirectory.repEmailDomain}`.toLowerCase(),
      password: config.authDirectory.repDefaultPassword,
      full_name: `${config.authDirectory.repNamePrefix}${separator}${suffix}`.trim(),
      role: 'field_rep',
      is_active: true,
      db_user_id: uuidv5(`${config.authDirectory.repIdPrefix}${suffix}`, DEVICE_USER_NAMESPACE),
      data_scope: null,
    };
  });

  return [manager, ...reps];
}

function listUsers() {
  if (Array.isArray(config.authDirectory.customUsers) && config.authDirectory.customUsers.length) {
    return config.authDirectory.customUsers.map(normalizeCustomUser);
  }
  return buildVirtualUsers();
}

function listFieldReps() {
  return listUsers().filter((user) => user.role === 'field_rep' && user.is_active);
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    is_active: user.is_active,
    db_user_id: user.db_user_id,
    data_scope: user.data_scope || null,
  };
}

function getUserById(id) {
  const user = listUsers().find((row) => String(row.id) === String(id) && row.is_active);
  return sanitizeUser(user);
}

function getUserByEmail(email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = listUsers().find((row) => row.email === normalizedEmail && row.is_active);
  return sanitizeUser(user);
}

function getUserByDbUserId(dbUserId) {
  const normalized = String(dbUserId || '').trim().toLowerCase();
  const user = listUsers().find((row) => String(row.db_user_id).toLowerCase() === normalized && row.is_active);
  return sanitizeUser(user);
}

function getDbUserId(userId) {
  const user = listUsers().find((row) => String(row.id) === String(userId) && row.is_active);
  return user?.db_user_id || null;
}

function authenticate(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = listUsers().find((row) => row.email === normalizedEmail && row.is_active);
  if (!user || String(password || '') !== String(user.password || '')) {
    const err = new Error('Invalid credentials');
    err.status = 401;
    throw err;
  }

  return sanitizeUser(user);
}

function listUsersByScope(scope) {
  const all = listUsers();
  if (scope === 'demo') return all.filter((u) => u.data_scope === 'demo');
  return all.filter((u) => u.data_scope !== 'demo');
}

function listFieldRepsByScope(scope) {
  return listUsersByScope(scope).filter((u) => u.role === 'field_rep' && u.is_active);
}

module.exports = {
  listUsers,
  listFieldReps,
  listUsersByScope,
  listFieldRepsByScope,
  getUserById,
  getUserByEmail,
  getUserByDbUserId,
  getDbUserId,
  authenticate,
};
