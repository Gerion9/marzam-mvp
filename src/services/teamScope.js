/**
 * Team / hierarchy helpers — used by visit-plans, /api/team, and analytics.
 *
 * The hierarchy is the `users.manager_id` self-reference. Cascade rules
 * (per the plan):
 *   director_sucursal → ve gerente_ventas + supervisor + representante (de su sucursal)
 *   gerente_ventas    → ve supervisor + representante (sus subordinados)
 *   supervisor        → ve representante (sus subordinados)
 *   representante     → no team
 */

const db = require('../config/database');
const { ROLES, normalizeRole } = require('../constants/roles');

const ROLE_RANK = {
  [ROLES.DIRECTOR_SUCURSAL]: 4,
  [ROLES.GERENTE_VENTAS]: 3,
  [ROLES.SUPERVISOR]: 2,
  [ROLES.REPRESENTANTE]: 1,
};

const ROLES_BELOW = {
  [ROLES.DIRECTOR_SUCURSAL]: [ROLES.GERENTE_VENTAS, ROLES.SUPERVISOR, ROLES.REPRESENTANTE],
  [ROLES.GERENTE_VENTAS]: [ROLES.SUPERVISOR, ROLES.REPRESENTANTE],
  [ROLES.SUPERVISOR]: [ROLES.REPRESENTANTE],
  [ROLES.REPRESENTANTE]: [],
};

function rolesBelow(role) {
  return ROLES_BELOW[normalizeRole(role)] || [];
}

function rank(role) {
  return ROLE_RANK[normalizeRole(role)] || 0;
}

function canManage(actorRole, targetRole) {
  return rank(actorRole) > rank(targetRole);
}

/**
 * Direct reports of `userId` — one level down.
 */
async function getDirectReports(userId) {
  return db('users')
    .select('id', 'full_name', 'role', 'employee_code', 'branch_id', 'is_active')
    .where({ manager_id: userId, is_active: true })
    .orderBy('full_name', 'asc');
}

/**
 * Recursive descendants of `userId` via manager_id (multi-level cascade).
 * Director → all gerentes/supervisores/reps under him.
 */
async function getDescendants(userId) {
  const rows = await db.raw(`
    WITH RECURSIVE team AS (
      SELECT id, full_name, role, employee_code, branch_id, manager_id, 0 AS depth
        FROM users
       WHERE manager_id = ?
         AND is_active = true
      UNION ALL
      SELECT u.id, u.full_name, u.role, u.employee_code, u.branch_id, u.manager_id, t.depth + 1
        FROM users u
        JOIN team t ON u.manager_id = t.id
       WHERE u.is_active = true
    )
    SELECT * FROM team ORDER BY depth, full_name;
  `, [userId]);
  return rows.rows || [];
}

/**
 * Check whether `actorId` is an ancestor of `targetId` in the management chain.
 * A director can also manage anyone in the same branch even without an explicit
 * manager_id link (covers reps that haven't been wired into a supervisor yet).
 */
async function canActorManage(actorId, targetId) {
  if (actorId === targetId) return false;
  const actor = await db('users').select('id', 'role', 'branch_id').where({ id: actorId }).first();
  const target = await db('users').select('id', 'role', 'branch_id', 'manager_id').where({ id: targetId }).first();
  if (!actor || !target) return false;

  if (!canManage(actor.role, target.role)) return false;

  // walk up target's chain
  let cursor = target.manager_id;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    if (cursor === actorId) return true;
    seen.add(cursor);
    const parent = await db('users').select('manager_id').where({ id: cursor }).first();
    cursor = parent?.manager_id || null;
  }

  // fallback: same branch + actor is director_sucursal
  if (
    normalizeRole(actor.role) === ROLES.DIRECTOR_SUCURSAL
    && actor.branch_id
    && target.branch_id === actor.branch_id
  ) {
    return true;
  }
  return false;
}

/**
 * Returns the cascade tree under `userId` grouped by direct depth and role.
 * Used by /api/team to render the cards.
 */
async function getTeamCascade(userId) {
  const descendants = await getDescendants(userId);
  const byRole = {};
  for (const u of descendants) {
    const r = normalizeRole(u.role);
    if (!byRole[r]) byRole[r] = [];
    byRole[r].push(u);
  }
  return { descendants, byRole };
}

module.exports = {
  ROLE_RANK,
  ROLES_BELOW,
  rolesBelow,
  rank,
  canManage,
  canActorManage,
  getDirectReports,
  getDescendants,
  getTeamCascade,
};
