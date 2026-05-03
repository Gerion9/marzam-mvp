const db = require('../../config/database');
const { getDescendants, canActorManage } = require('../../services/teamScope');
const { normalizeRole } = require('../../constants/roles');

/**
 * Compliance heatmap: for each subordinate × day in the window, returns
 * planned and done counts.
 */
async function complianceHeatmap({ actor, scopeUserId = null, dateFrom, dateTo }) {
  const today = new Date().toISOString().slice(0, 10);
  const from = dateFrom || today.slice(0, 7) + '-01';
  const to = dateTo || today;

  // Default scope: descendants of actor.
  let userIds;
  if (scopeUserId) {
    if (scopeUserId !== actor.id && !actor.is_global && !await canActorManage(actor.id, scopeUserId)) {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    }
    if (scopeUserId === actor.id) {
      userIds = [actor.id];
    } else {
      const descendants = await getDescendants(scopeUserId);
      userIds = [scopeUserId, ...descendants.map((d) => d.id)];
    }
  } else {
    const descendants = await getDescendants(actor.id);
    userIds = descendants.map((d) => d.id);
  }
  if (!userIds.length) return { rows: [], users: [] };

  const rows = await db('visit_plan_assignments as vpa')
    .whereIn('vpa.visitor_user_id', userIds)
    .andWhere('vpa.scheduled_date', '>=', from)
    .andWhere('vpa.scheduled_date', '<=', to)
    .leftJoin('users as u', 'u.id', 'vpa.visitor_user_id')
    .select('vpa.visitor_user_id', 'u.full_name', 'u.role', 'vpa.scheduled_date')
    .select(db.raw(`COUNT(*) AS planned`))
    .select(db.raw(`COUNT(*) FILTER (WHERE vpa.status = 'done') AS done`))
    .groupBy('vpa.visitor_user_id', 'u.full_name', 'u.role', 'vpa.scheduled_date')
    .orderBy('u.full_name')
    .orderBy('vpa.scheduled_date');

  // Pivot users for the heatmap
  const userMap = new Map();
  for (const r of rows) {
    if (!userMap.has(r.visitor_user_id)) {
      userMap.set(r.visitor_user_id, {
        user_id: r.visitor_user_id,
        full_name: r.full_name,
        role: r.role,
      });
    }
  }
  return {
    period: { from, to },
    users: Array.from(userMap.values()),
    rows: rows.map((r) => ({
      user_id: r.visitor_user_id,
      date: r.scheduled_date,
      planned: Number(r.planned) || 0,
      done: Number(r.done) || 0,
      compliance_pct: Number(r.planned) > 0 ? Math.round((Number(r.done) / Number(r.planned)) * 1000) / 10 : null,
    })),
  };
}

/**
 * PARETO mix: distribution of A/B/C visits in the window for the actor's team.
 */
async function paretoMix({ actor, scopeUserId = null, dateFrom, dateTo }) {
  const today = new Date().toISOString().slice(0, 10);
  const from = dateFrom || today.slice(0, 7) + '-01';
  const to = dateTo || today;

  let userIds;
  if (scopeUserId) {
    if (scopeUserId !== actor.id && !actor.is_global && !await canActorManage(actor.id, scopeUserId)) {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    }
    const descendants = await getDescendants(scopeUserId);
    userIds = [scopeUserId, ...descendants.map((d) => d.id)];
  } else {
    const descendants = await getDescendants(actor.id);
    userIds = [actor.id, ...descendants.map((d) => d.id)];
  }
  if (!userIds.length) return [];

  const rows = await db('visit_plan_assignments as vpa')
    .whereIn('vpa.visitor_user_id', userIds)
    .andWhere('vpa.scheduled_date', '>=', from)
    .andWhere('vpa.scheduled_date', '<=', to)
    .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
    .select('mc.pareto')
    .select(db.raw(`COUNT(*) AS planned`))
    .select(db.raw(`COUNT(*) FILTER (WHERE vpa.status = 'done') AS done`))
    .groupBy('mc.pareto')
    .orderBy('mc.pareto');

  return rows.map((r) => ({
    pareto: r.pareto,
    planned: Number(r.planned) || 0,
    done: Number(r.done) || 0,
  }));
}

/**
 * Untouched-clients list: marzam_clients in the actor's scope that have not
 * been visited (no assignments with status='done') in the last N days.
 */
async function untouchedClients({ actor, daysWithout = 30, limit = 25 }) {
  const cutoff = new Date(Date.now() - daysWithout * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const descendants = await getDescendants(actor.id);
  const userIds = [actor.id, ...descendants.map((d) => d.id)];
  if (!userIds.length) return [];

  // marzam_clients planned in the window for the actor's team but never visited
  const rows = await db.raw(`
    WITH team_assignments AS (
      SELECT marzam_client_id, MAX(completed_at) AS last_completed
        FROM visit_plan_assignments
       WHERE visitor_user_id = ANY(?)
       GROUP BY marzam_client_id
    )
    SELECT mc.id, mc.cpadre, mc.farmacia_nombre, mc.pareto, mc.delegacion_municipio,
           ta.last_completed
      FROM marzam_clients mc
      LEFT JOIN team_assignments ta ON ta.marzam_client_id = mc.id
     WHERE ta.last_completed IS NULL OR ta.last_completed < ?::timestamptz
     ORDER BY mc.pareto, mc.farmacia_nombre
     LIMIT ?
  `, [userIds, cutoff, limit]);
  return rows.rows || [];
}

module.exports = {
  complianceHeatmap,
  paretoMix,
  untouchedClients,
};
