const db = require('../../config/database');
const planGenerator = require('./planGenerator');
const { canActorManage } = require('../../services/teamScope');

async function listForUser({ userId, isGlobal = false }) {
  const q = db('visit_plans as vp')
    .select('vp.*')
    .leftJoin('users as o', 'o.id', 'vp.owner_user_id')
    .leftJoin('users as s', 's.id', 'vp.scope_user_id')
    .select('o.full_name as owner_name', 's.full_name as scope_user_name')
    .orderBy('vp.created_at', 'desc')
    .limit(200);
  if (!isGlobal) {
    q.where(function () {
      this.where('vp.owner_user_id', userId).orWhere('vp.scope_user_id', userId);
    });
  }
  return q;
}

async function getById(id, { userId, isGlobal }) {
  const plan = await db('visit_plans').where({ id }).first();
  if (!plan) return null;
  const ownerCanSee = isGlobal || plan.owner_user_id === userId || plan.scope_user_id === userId;
  if (!ownerCanSee) {
    if (plan.scope_user_id && !await canActorManage(userId, plan.scope_user_id)) {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    }
  }
  // Post-migración 050 cada assignment apunta a UN cliente Marzam (mc) O a UNA
  // farmacia prospecto (pp).  Resolvemos ambos con LEFT JOINs y devolvemos
  // los campos coalescidos para que el FE pinte la fila igual sin importar
  // el origen.  El campo `target_type` deja explícito el tipo para badges.
  const assignments = await db('visit_plan_assignments as vpa')
    .where({ visit_plan_id: id })
    .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
    .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
    .leftJoin('users as v', 'v.id', 'vpa.visitor_user_id')
    .select(
      'vpa.*',
      'mc.cpadre',
      db.raw('COALESCE(mc.farmacia_nombre, pp.name) AS farmacia_nombre'),
      // Prospectos NO tienen pareto formal — los marcamos como 'C' (regla negocio).
      db.raw("COALESCE(mc.pareto, pp.pareto, CASE WHEN vpa.pharmacy_id IS NOT NULL THEN 'C' ELSE NULL END) AS pareto"),
      db.raw('COALESCE(mc.delegacion_municipio, pp.municipality) AS delegacion_municipio'),
      db.raw("CASE WHEN vpa.pharmacy_id IS NOT NULL THEN 'prospect' ELSE 'client' END AS target_type"),
      'v.full_name as visitor_name',
      'v.role as visitor_role',
    )
    .orderBy('vpa.scheduled_date')
    .orderBy('vpa.route_order');
  return { ...plan, assignments };
}

async function preview({ ownerUserId, scopeUserIds, periodStart, periodEnd, paretoFilter }) {
  // Lightweight preview: same target resolution as generate, but no inserts.
  const trx = db;
  const scopeUsers = await trx('users')
    .select('id', 'role', 'full_name', 'branch_id')
    .whereIn('id', scopeUserIds)
    .andWhere({ is_active: true });

  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  let workingDays = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const d = cursor.getUTCDay();
    if (d !== 0 && d !== 6) workingDays += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const targetsByUser = {};
  let totalDailyVisits = 0;
  const firstDay = periodStart;
  for (const u of scopeUsers) {
    targetsByUser[u.id] = {};
    for (const pareto of (paretoFilter || ['A', 'B', 'C'])) {
      const r = await trx.raw('SELECT resolve_visit_target(?, ?::char(1), ?, ?::date) AS v', [
        u.id, pareto, 'visit', firstDay,
      ]);
      const v = r.rows?.[0]?.v ?? 0;
      targetsByUser[u.id][pareto] = v;
      totalDailyVisits += v;
    }
  }
  return {
    working_days: workingDays,
    estimated_total_visits: totalDailyVisits * workingDays,
    daily_visits_total: totalDailyVisits,
    per_user: targetsByUser,
  };
}

async function publish(id, userId) {
  const plan = await db('visit_plans').where({ id }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  if (plan.owner_user_id !== userId) {
    const err = new Error('Only owner can publish');
    err.status = 403;
    throw err;
  }
  const [updated] = await db('visit_plans').where({ id }).update({
    status: 'published',
    updated_at: db.fn.now(),
  }).returning('*');
  return updated;
}

async function archive(id, userId) {
  const plan = await db('visit_plans').where({ id }).first();
  if (!plan) {
    const err = new Error('Plan not found');
    err.status = 404;
    throw err;
  }
  if (plan.owner_user_id !== userId) {
    const err = new Error('Only owner can archive');
    err.status = 403;
    throw err;
  }
  const [updated] = await db('visit_plans').where({ id }).update({
    status: 'archived',
    updated_at: db.fn.now(),
  }).returning('*');
  return updated;
}

async function listAssignmentsForUser({ visitorUserId, dateFrom, dateTo }) {
  // Cada assignment puede venir de:
  //   (A) cliente Marzam   → vpa.marzam_client_id → mc → mc.pharmacy_id → p (geo)
  //   (B) prospecto         → vpa.pharmacy_id → pp directo (geo)
  // El COALESCE colapsa ambos casos en una sola fila plana para el FE.
  // pharmacy_id se devuelve como `geo_pharmacy_id` para no chocar con la
  // columna real `vpa.pharmacy_id` (que el SELECT * arrastra).
  const q = db('visit_plan_assignments as vpa')
    .where('vpa.visitor_user_id', visitorUserId)
    .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
    .leftJoin('pharmacies as p',  'p.id',  'mc.pharmacy_id')
    .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
    .select(
      'vpa.*',
      'mc.cpadre',
      db.raw('COALESCE(mc.farmacia_nombre, pp.name) AS farmacia_nombre'),
      db.raw("COALESCE(mc.pareto, pp.pareto, CASE WHEN vpa.pharmacy_id IS NOT NULL THEN 'C' ELSE NULL END) AS pareto"),
      db.raw('COALESCE(mc.delegacion_municipio, pp.municipality) AS delegacion_municipio'),
      'mc.poblacion',
      db.raw("CASE WHEN vpa.pharmacy_id IS NOT NULL THEN 'prospect' ELSE 'client' END AS target_type"),
      db.raw('COALESCE(p.id, pp.id) AS geo_pharmacy_id'),
      db.raw('COALESCE(ST_X(p.coordinates::geometry), ST_X(pp.coordinates::geometry)) AS lng'),
      db.raw('COALESCE(ST_Y(p.coordinates::geometry), ST_Y(pp.coordinates::geometry)) AS lat'),
    )
    .orderBy('vpa.scheduled_date')
    .orderBy('vpa.route_order');
  if (dateFrom) q.andWhere('vpa.scheduled_date', '>=', dateFrom);
  if (dateTo) q.andWhere('vpa.scheduled_date', '<=', dateTo);
  return q;
}

module.exports = {
  generate: planGenerator.generate,
  preview,
  listForUser,
  getById,
  publish,
  archive,
  listAssignmentsForUser,
};
