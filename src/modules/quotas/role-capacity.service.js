const db = require('../../config/database');
const { userIdsInPoblacion } = require('../../services/poblacionScope');

const ROLES_ORDER = ['director_sucursal', 'gerente_ventas', 'supervisor', 'representante'];

/**
 * Returns role capacity rows for a given poblacion (or global if null).
 * Each row includes real headcount (from live users table) and the saved
 * target_headcount / days_per_month from role_capacity_targets.
 */
async function listRoleCapacity({ poblacion = null } = {}) {
  // Determine which user IDs to count
  let userIds = null;
  if (poblacion) {
    userIds = await userIdsInPoblacion(poblacion);
    if (!userIds.length) {
      // No users in this poblacion — return zero rows with saved targets
      const targets = await _loadTargets(poblacion);
      return ROLES_ORDER.map((role) => _buildRow(role, 0, targets.get(role)));
    }
  }

  // Count active users by role
  let q = db('users')
    .select(db.raw('role, COUNT(*)::int AS real_headcount'))
    .where('is_active', true)
    .whereIn('role', ROLES_ORDER);
  if (userIds) q = q.whereIn('id', userIds);
  const hcRows = await q.groupBy('role');
  const realByRole = new Map(hcRows.map((r) => [r.role, r.real_headcount]));

  const targets = await _loadTargets(poblacion);

  return ROLES_ORDER.map((role) => _buildRow(role, realByRole.get(role) || 0, targets.get(role)));
}

async function _loadTargets(poblacion) {
  const rows = await db('role_capacity_targets').where(function () {
    if (poblacion) this.where('poblacion', poblacion);
    else this.whereNull('poblacion');
  });
  return new Map(rows.map((r) => [r.role, r]));
}

function _buildRow(role, realHeadcount, target) {
  const targetHeadcount = target?.target_headcount ?? 0;
  const daysPerMonth = target?.days_per_month ?? 22;
  return {
    role,
    real_headcount: realHeadcount,
    target_headcount: targetHeadcount,
    days_per_month: daysPerMonth,
    gap: Math.max(0, targetHeadcount - realHeadcount),
    db_id: target?.id ?? null,
  };
}

/**
 * Upsert a single (poblacion, role) row.
 */
async function upsertRoleCapacity({ actor, poblacion = null, role, targetHeadcount, daysPerMonth }) {
  const existing = await db('role_capacity_targets')
    .where(function () {
      if (poblacion) this.where('poblacion', poblacion);
      else this.whereNull('poblacion');
    })
    .andWhere('role', role)
    .first();

  const updates = {};
  if (targetHeadcount !== undefined && Number(targetHeadcount) >= 0) {
    updates.target_headcount = Number(targetHeadcount);
  }
  if (daysPerMonth !== undefined && Number(daysPerMonth) >= 0 && Number(daysPerMonth) <= 31) {
    updates.days_per_month = Number(daysPerMonth);
  }
  updates.set_by_user_id = actor.id;
  updates.updated_at = new Date();

  if (existing) {
    const [updated] = await db('role_capacity_targets')
      .where({ id: existing.id })
      .update(updates)
      .returning('*');
    return updated;
  }

  const [created] = await db('role_capacity_targets')
    .insert({
      poblacion: poblacion || null,
      role,
      target_headcount: updates.target_headcount ?? 0,
      days_per_month: updates.days_per_month ?? 22,
      set_by_user_id: actor.id,
      updated_at: updates.updated_at,
    })
    .returning('*');
  return created;
}

module.exports = {
  listRoleCapacity,
  upsertRoleCapacity,
  ROLES_ORDER,
};
