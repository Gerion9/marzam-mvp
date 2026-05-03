const db = require('../../config/database');
const { getTeamCascade, getDirectReports, canActorManage } = require('../../services/teamScope');
const { ROLES } = require('../../constants/roles');
const marzamReadonly = require('../marzam-readonly/marzam.service');

// Real Marzam clave convention (verified 2026-04-29):
//   - Director:     no aparece en cuadro_basico — identificado por sucursal.
//   - Gerente:      employee_code = gerencia_code (UE, ME, ...).
//   - Supervisor:   clave = 3 letras + '00' (UEA00). LEFT(clave,3) = supervisor_code.
//   - Representante: clave = supervisor_code + 2 dígitos (UEA01).
//
// When the `users` table doesn't exist yet (tables not migrated, see
// docs/ROADMAP-PRODUCTION.md), we fall back to building the cascade from
// the real marzam-readonly layer using these prefix rules.
function isManagedBy(actorCode, actorRole, target) {
  if (!actorCode) return false;
  const ac = String(actorCode);
  switch (actorRole) {
    case ROLES.DIRECTOR_SUCURSAL:
      return true; // sucursal-wide
    case ROLES.GERENTE_VENTAS:
      return target.gerencia_code === ac;
    case ROLES.SUPERVISOR:
      return (target.supervisor_code === ac.slice(0, 3))
        && target.employee_code !== actorCode;
    default:
      return false;
  }
}

async function buildFallbackCascade(actor) {
  const reps = await marzamReadonly.getRepresentatives();
  const actorCode = actor.employee_code || null;
  const role = actor.role;
  const descendants = reps.filter((r) => isManagedBy(actorCode, role, r));
  // Sort by role rank then name so the response is stable.
  const RANK = { gerente_ventas: 0, supervisor: 1, representante: 2 };
  descendants.sort((a, b) => (RANK[a.role] - RANK[b.role]) || (a.full_name || '').localeCompare(b.full_name || ''));
  const byRole = {};
  for (const u of descendants) {
    if (!byRole[u.role]) byRole[u.role] = [];
    byRole[u.role].push({ ...u, metrics: { planned: 0, done: 0, compliance_pct: null } });
  }
  return {
    descendants: descendants.map((u) => ({
      ...u,
      id: u.employee_code, // synthetic id while users table is absent
      metrics: { planned: 0, done: 0, compliance_pct: null },
    })),
    by_role: byRole,
  };
}

async function getMetricsForUsers(userIds, { dateFrom, dateTo } = {}) {
  if (!userIds.length) return {};
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const from = dateFrom || monthStart;
  const to = dateTo || today;

  // Planned vs done counts in window
  const rows = await db('visit_plan_assignments')
    .whereIn('visitor_user_id', userIds)
    .andWhere('scheduled_date', '>=', from)
    .andWhere('scheduled_date', '<=', to)
    .select('visitor_user_id')
    .select(db.raw(`COUNT(*) AS planned`))
    .select(db.raw(`COUNT(*) FILTER (WHERE status = 'done') AS done`))
    .select(db.raw(`COUNT(*) FILTER (WHERE status = 'done' AND scheduled_date = ?) AS done_today`, [today]))
    .select(db.raw(`COUNT(*) FILTER (WHERE scheduled_date = ?) AS planned_today`, [today]))
    .groupBy('visitor_user_id');

  const map = {};
  for (const r of rows) {
    const planned = Number(r.planned) || 0;
    const done = Number(r.done) || 0;
    map[r.visitor_user_id] = {
      planned,
      done,
      done_today: Number(r.done_today) || 0,
      planned_today: Number(r.planned_today) || 0,
      compliance_pct: planned > 0 ? Math.round((done / planned) * 1000) / 10 : null,
    };
  }
  return map;
}

async function getCascade({ userId, dateFrom, dateTo, actor }) {
  try {
    const { descendants, byRole } = await getTeamCascade(userId);
    const allIds = descendants.map((u) => u.id);
    const metrics = await getMetricsForUsers(allIds, { dateFrom, dateTo });

    return {
      descendants: descendants.map((u) => ({
        ...u,
        metrics: metrics[u.id] || { planned: 0, done: 0, compliance_pct: null },
      })),
      by_role: Object.fromEntries(
        Object.entries(byRole).map(([role, users]) => [
          role,
          users.map((u) => ({ ...u, metrics: metrics[u.id] || { planned: 0, done: 0, compliance_pct: null } })),
        ]),
      ),
    };
  } catch (err) {
    // Fallback path: the destination tables don't exist yet — build the
    // cascade from the real marzam-readonly layer.
    if (err && /relation "users" does not exist|relation "visit_plan_assignments" does not exist/.test(String(err.message || ''))) {
      if (!actor) throw err;
      return buildFallbackCascade(actor);
    }
    throw err;
  }
}

async function getMember({ actorId, targetUserId, isGlobal, dateFrom, dateTo }) {
  if (!isGlobal && actorId !== targetUserId) {
    if (!await canActorManage(actorId, targetUserId)) {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    }
  }
  const user = await db('users')
    .leftJoin('branches as b', 'b.id', 'users.branch_id')
    .leftJoin('users as m', 'm.id', 'users.manager_id')
    .select(
      'users.id', 'users.full_name', 'users.role', 'users.email', 'users.employee_code',
      'users.branch_id', 'b.name as branch_name', 'b.code as branch_code',
      'm.full_name as manager_name', 'm.id as manager_id',
    )
    .where('users.id', targetUserId)
    .first();
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const reports = await getDirectReports(targetUserId);
  const reportIds = reports.map((r) => r.id);
  const metrics = await getMetricsForUsers([targetUserId, ...reportIds], { dateFrom, dateTo });

  return {
    user: { ...user, metrics: metrics[user.id] || null },
    direct_reports: reports.map((r) => ({ ...r, metrics: metrics[r.id] || null })),
  };
}

module.exports = {
  getCascade,
  getMember,
  getMetricsForUsers,
};
