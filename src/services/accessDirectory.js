const config = require('../config');
const { v5: uuidv5 } = require('uuid');
const { ROLES, ROLE_VALUES, normalizeRole } = require('../constants/roles');

const DEVICE_USER_NAMESPACE = '74e8d182-c5ba-4f5c-bffe-7549315401a3';

// Legacy roles still accepted while the rename rolls out.
const LEGACY_ROLES = new Set(['manager', 'field_rep']);

// BlackPrint admin override.
//
// Comma-separated list of emails (BLACKPRINT_ADMIN_EMAILS) that should be
// promoted to role=blackprint_admin regardless of what the source directory
// says. Read lazily so test suites can mutate process.env between cases.
//
// Semantics: this is a pure ROLE override — the user must already exist in the
// directory (via AUTH_DIRECTORY_JSON customUsers, the auto-generated rep set,
// or the manager). Listing an email that no one has does NOT create a ghost
// user; nothing happens.
function getBlackprintAdminEmails() {
  const raw = String(process.env.BLACKPRINT_ADMIN_EMAILS || '').trim();
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function isBlackprintAdminEmail(email) {
  if (!email) return false;
  return getBlackprintAdminEmails().has(String(email).trim().toLowerCase());
}

function applyBlackprintOverride(users) {
  const set = getBlackprintAdminEmails();
  if (set.size === 0) return users;
  return users.map((u) => (
    set.has(String(u.email || '').trim().toLowerCase())
      ? { ...u, role: ROLES.BLACKPRINT_ADMIN }
      : u
  ));
}

function pad(num) {
  return String(num).padStart(3, '0');
}

/**
 * Accept any role in the canonical enum (`director_sucursal`, `gerente_ventas`,
 * `supervisor`, `representante`) OR the two legacy values (`manager`,
 * `field_rep`) that older tracking/seed code still emits.
 *
 * Falls back to `representante` (the safest least-privilege role) when an
 * unknown value is provided.
 */
function resolveRole(role) {
  if (!role) return ROLES.REPRESENTANTE;
  const canonical = normalizeRole(role);
  if (ROLE_VALUES.includes(canonical)) return canonical;
  if (LEGACY_ROLES.has(role)) return role;
  return ROLES.REPRESENTANTE;
}

function normalizeCustomUser(user, index) {
  return {
    id: String(user.id || user.employee_code || `custom${pad(index + 1)}`),
    email: String(user.email || '').trim().toLowerCase(),
    password: String(user.password || config.authDirectory.repDefaultPassword),
    full_name: String(user.full_name || user.name || `Custom User ${index + 1}`),
    role: resolveRole(user.role),
    is_active: user.is_active !== false,
    db_user_id: user.db_user_id || uuidv5(String(user.id || user.email || `custom${index + 1}`), DEVICE_USER_NAMESPACE),
    data_scope: user.data_scope || null,
    // Marzam-specific identity tokens propagated end-to-end so the
    // /api/marzam/* read-through layer can scope by employee_code.
    employee_code: user.employee_code || null,
    employee_number: user.employee_number || null,
    branch_code: user.branch_code || null,
    manager_code: user.manager_code || null,
    must_change_password: user.must_change_password !== false,
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
  const virtualUsers = buildVirtualUsers();
  let merged;
  if (Array.isArray(config.authDirectory.customUsers) && config.authDirectory.customUsers.length) {
    const customUsers = config.authDirectory.customUsers.map(normalizeCustomUser);
    const customIds = new Set(customUsers.map((u) => u.id));
    const customEmails = new Set(customUsers.map((u) => u.email));
    const filtered = virtualUsers.filter((u) => !customIds.has(u.id) && !customEmails.has(u.email));
    merged = [...filtered, ...customUsers];
  } else {
    merged = virtualUsers;
  }
  // Apply BLACKPRINT_ADMIN_EMAILS override last so it wins over both the
  // auto-generated and the customUsers branches.
  return applyBlackprintOverride(merged);
}

function listFieldReps() {
  // Treat both the legacy `field_rep` and the canonical `representante`
  // as field reps for downstream consumers (assignments, reporting).
  return listUsers().filter((user) => (
    (user.role === 'field_rep' || user.role === ROLES.REPRESENTANTE) && user.is_active
  ));
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
    employee_code: user.employee_code || null,
    employee_number: user.employee_number || null,
    branch_code: user.branch_code || null,
    manager_code: user.manager_code || null,
    must_change_password: user.must_change_password === true,
  };
}

// `id` may be the virtual identifier (`u-dir-001`), the canonical UUID
// (`db_user_id`), the `employee_code`, or the email. We try each in order
// so backend code paths post-JWT-UUID-migration still resolve correctly.
function getUserById(id) {
  if (id == null) return null;
  const needle = String(id).trim();
  const lower = needle.toLowerCase();
  const user = listUsers().find((row) => row.is_active && (
    String(row.id) === needle
    || String(row.db_user_id).toLowerCase() === lower
    || String(row.employee_code || '').toLowerCase() === lower
    || String(row.email || '').toLowerCase() === lower
  ));
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

// Resolves any identifier (virtual id, UUID, employee_code, email) to the
// canonical UUID stored in `users.id`. Idempotent for already-UUID inputs.
function getDbUserId(userId) {
  const user = getUserById(userId);
  return user?.db_user_id || null;
}

// Lightweight UUID v1-v5 detector. We only need to disambiguate "is this
// already a canonical UUID?" from "is this a virtual id / employee_code /
// email that needs translation?" — RFC 4122 strict validation is overkill.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCanonicalUuid(input) {
  return typeof input === 'string' && UUID_RE.test(input.trim());
}

/**
 * Translate any identifier shape into the canonical `users.id` UUID.
 *
 * Accepts:
 *   - canonical UUID         → returned unchanged
 *   - virtual id ('u-dir-001') → uuidv5(id, NS)
 *   - employee_code ('UEA01')  → uuidv5(<owning user id>, NS)
 *   - email                    → uuidv5(<owning user id>, NS)
 *
 * Returns the original input when nothing matches, so callers can decide
 * whether to fail loudly or attempt a DB query as a fallback (DB lookups by
 * UUID-shaped strings are safe; lookups by raw virtual ids would crash on
 * uuid columns, which is exactly what we want to avoid here).
 */
function toCanonicalId(input) {
  if (input == null) return null;
  const value = String(input).trim();
  if (!value) return null;
  if (isCanonicalUuid(value)) return value;
  const uuid = getDbUserId(value);
  return uuid || value;
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
  return listUsersByScope(scope).filter((u) => (
    (u.role === 'field_rep' || u.role === ROLES.REPRESENTANTE) && u.is_active
  ));
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
  toCanonicalId,
  isCanonicalUuid,
  authenticate,
  isBlackprintAdminEmail,
  getBlackprintAdminEmails,
};
