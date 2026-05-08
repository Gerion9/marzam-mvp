const db = require('../../config/database');
const { normalizeRole, ROLES } = require('../../constants/roles');
const { getDirectReports } = require('../../services/teamScope');

function err(status, message) { const e = new Error(message); e.status = status; throw e; }

const RANK = {
  [ROLES.DIRECTOR_SUCURSAL]: 4,
  [ROLES.GERENTE_VENTAS]: 3,
  [ROLES.SUPERVISOR]: 2,
  [ROLES.REPRESENTANTE]: 1,
};

/**
 * Regla "solo 1 nivel abajo": el actor debe ser exactamente 1 rank arriba del target.
 * Y el target debe tener manager_id = actor.id (no salta jerarquía).
 */
async function assertCanSetQuotaFor(actorId, targetUserId) {
  if (actorId === targetUserId) err(403, 'No puedes asignarte cuota a ti mismo');
  const actor = await db('users').select('id', 'role').where({ id: actorId }).first();
  const target = await db('users').select('id', 'role', 'manager_id').where({ id: targetUserId }).first();
  if (!actor || !target) err(404, 'Usuario no encontrado');
  const aRank = RANK[normalizeRole(actor.role)] || 0;
  const tRank = RANK[normalizeRole(target.role)] || 0;
  if (aRank - tRank !== 1) err(403, 'Solo puedes fijar metas a tus subordinados directos (un nivel abajo)');
  if (target.manager_id !== actorId) err(403, 'Ese usuario no es subordinado directo tuyo');
}

async function listSubordinates(actorId) {
  const reports = await getDirectReports(actorId);
  return reports;
}

async function listQuotasByPeriod({ actorId, periodStart, periodEnd }) {
  const reports = await getDirectReports(actorId);
  if (!reports.length) return [];
  const ids = reports.map((r) => r.id);

  // Buscar quotas dentro del período
  const quotas = await db('visit_quotas')
    .whereIn('target_user_id', ids)
    .andWhere('period_start', '<=', periodEnd)
    .andWhere('period_end', '>=', periodStart);

  const byTarget = new Map();
  for (const q of quotas) {
    if (!byTarget.has(q.target_user_id)) byTarget.set(q.target_user_id, q);
  }

  // Visitas reales en el rango — agrupado por rep_id, separado nuevas vs clientes
  // (nuevas = pharmacies.source <> 'marzam')
  const actuals = await db.raw(
    `
    SELECT
      v.rep_id AS user_id,
      COUNT(*) FILTER (WHERE COALESCE(p.source,'') <> 'marzam')::int AS visits_new,
      COUNT(*) FILTER (WHERE p.source = 'marzam')::int AS visits_existing
    FROM visit_reports v
    LEFT JOIN pharmacies p ON p.id = v.pharmacy_id
    WHERE v.rep_id = ANY(?)
      AND v.created_at::date BETWEEN ?::date AND ?::date
    GROUP BY v.rep_id
    `,
    [ids, periodStart, periodEnd],
  );
  const actualsByUser = new Map();
  (actuals.rows || actuals).forEach((r) => actualsByUser.set(r.user_id, r));

  return reports.map((r) => {
    const q = byTarget.get(r.id) || null;
    const a = actualsByUser.get(r.id) || { visits_new: 0, visits_existing: 0 };
    const targetNew = q?.target_new || 0;
    const targetExisting = q?.target_existing || 0;
    const blockedNew = targetNew > 0 && a.visits_new < targetNew;
    const blockedExisting = targetExisting > 0 && a.visits_existing < targetExisting;
    return {
      user_id: r.id,
      full_name: r.full_name,
      role: r.role,
      employee_code: r.employee_code,
      quota: q,
      actuals: a,
      blocked_new: blockedNew,
      blocked_existing: blockedExisting,
      gap_new: Math.max(0, targetNew - (a.visits_new || 0)),
      gap_existing: Math.max(0, targetExisting - (a.visits_existing || 0)),
    };
  });
}

async function upsertQuota({ actorId, targetUserId, periodStart, periodEnd, targetNew, targetExisting, mode = 'custom', notes }) {
  if (!periodStart || !periodEnd) err(422, 'period_start y period_end requeridos');
  if (Number(targetNew) < 0 || Number(targetExisting) < 0) err(422, 'metas no pueden ser negativas');
  await assertCanSetQuotaFor(actorId, targetUserId);

  const existing = await db('visit_quotas')
    .where({ target_user_id: targetUserId, period_start: periodStart, period_end: periodEnd })
    .first();

  if (existing) {
    const [updated] = await db('visit_quotas')
      .where({ id: existing.id })
      .update({
        target_new: Number(targetNew) || 0,
        target_existing: Number(targetExisting) || 0,
        mode,
        notes: notes || null,
        updated_at: db.fn.now(),
      })
      .returning('*');
    return updated;
  }
  const [created] = await db('visit_quotas').insert({
    set_by_user_id: actorId,
    target_user_id: targetUserId,
    period_start: periodStart,
    period_end: periodEnd,
    target_new: Number(targetNew) || 0,
    target_existing: Number(targetExisting) || 0,
    mode,
    notes: notes || null,
  }).returning('*');
  return created;
}

async function applyUniform({ actorId, periodStart, periodEnd, targetNew, targetExisting, notes }) {
  const reports = await getDirectReports(actorId);
  if (!reports.length) err(422, 'No tienes subordinados directos');
  const results = [];
  for (const r of reports) {
    try {
      const q = await upsertQuota({
        actorId, targetUserId: r.id, periodStart, periodEnd,
        targetNew, targetExisting, mode: 'uniform', notes,
      });
      results.push({ user_id: r.id, ok: true, quota: q });
    } catch (e) {
      results.push({ user_id: r.id, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = {
  listSubordinates,
  listQuotasByPeriod,
  upsertQuota,
  applyUniform,
};
