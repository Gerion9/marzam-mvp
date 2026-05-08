/**
 * Endpoints de analítica para los bloques E (quotas) y F (efectividad).
 *
 * Se mantiene en archivo separado para no enredar el analytics.controller
 * existente — las rutas se montan desde analytics.routes.js.
 */

const db = require('../../config/database');
const { getDescendants } = require('../../services/teamScope');
const { normalizeRole } = require('../../constants/roles');
const poblacion = require('../../services/poblacionScope');

/**
 * Indica si un error es de conectividad con la BD (Postgres). En esos
 * casos preferimos devolver shape vacía con 200 para que el frontend
 * no se rompa, en lugar de propagar 500.
 */
function isDbConnectionError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('connection terminated')
    || msg.includes('connection ended')
    || msg.includes('econnreset')
    || msg.includes('etimedout')
    || msg.includes('connect econn')
    || err.code === 'ECONNRESET'
    || err.code === 'ETIMEDOUT'
    || err.code === '57P01'
    || err.code === '57P02'
    || err.code === '57P03'
  );
}

function periodFromQuery(req) {
  const today = new Date();
  const defaultStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const defaultEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10);
  return {
    start: req.query.period_start || defaultStart,
    end: req.query.period_end || defaultEnd,
  };
}

/**
 * GET /api/analytics/quotas-blockages
 * Lista de subordinados (cascada completa) con su gap respecto a la quota.
 * Filtrable por `?role=representante` o `?poblacion=...`.
 */
async function quotasBlockages(req, res, next) {
  try {
    const { start, end } = periodFromQuery(req);
    const desc = await getDescendants(req.user.id);
    if (!desc.length) return res.json({ period_start: start, period_end: end, rows: [] });

    let userIds = desc.map((u) => u.id);
    if (req.query.role) {
      userIds = desc.filter((u) => normalizeRole(u.role) === req.query.role).map((u) => u.id);
    }
    if (req.query.poblacion) {
      const inPob = new Set(await poblacion.userIdsInPoblacion(req.query.poblacion));
      userIds = userIds.filter((id) => inPob.has(id));
    }
    if (!userIds.length) return res.json({ period_start: start, period_end: end, rows: [] });

    const quotas = await db('visit_quotas')
      .whereIn('target_user_id', userIds)
      .andWhere('period_start', '<=', end)
      .andWhere('period_end', '>=', start);
    const qByUser = new Map();
    for (const q of quotas) if (!qByUser.has(q.target_user_id)) qByUser.set(q.target_user_id, q);

    const actuals = await db.raw(
      `
      SELECT
        v.rep_id AS user_id,
        COUNT(*) FILTER (WHERE COALESCE(p.source,'') <> 'marzam')::int AS visits_new,
        COUNT(*) FILTER (WHERE p.source = 'marzam')::int AS visits_existing,
        COUNT(*) FILTER (WHERE v.order_placed = true)::int AS orders_placed,
        COALESCE(SUM(v.order_amount), 0)::numeric AS order_amount_total
      FROM visit_reports v
      LEFT JOIN pharmacies p ON p.id = v.pharmacy_id
      WHERE v.rep_id = ANY(?)
        AND v.created_at::date BETWEEN ?::date AND ?::date
      GROUP BY v.rep_id
      `,
      [userIds, start, end],
    );
    const aByUser = new Map();
    (actuals.rows || actuals).forEach((r) => aByUser.set(r.user_id, r));

    const userMap = new Map(desc.map((u) => [u.id, u]));
    const rows = userIds.map((id) => {
      const u = userMap.get(id) || {};
      const q = qByUser.get(id) || null;
      const a = aByUser.get(id) || { visits_new: 0, visits_existing: 0, orders_placed: 0, order_amount_total: 0 };
      const tn = q?.target_new || 0;
      const te = q?.target_existing || 0;
      return {
        user_id: id,
        full_name: u.full_name,
        role: u.role,
        target_new: tn,
        target_existing: te,
        visits_new: a.visits_new,
        visits_existing: a.visits_existing,
        gap_new: Math.max(0, tn - (a.visits_new || 0)),
        gap_existing: Math.max(0, te - (a.visits_existing || 0)),
        orders_placed: a.orders_placed,
        order_amount_total: Number(a.order_amount_total) || 0,
        blocked: (tn > 0 && a.visits_new < tn) || (te > 0 && a.visits_existing < te),
      };
    }).sort((x, y) => (y.gap_new + y.gap_existing) - (x.gap_new + x.gap_existing));

    res.json({ period_start: start, period_end: end, rows });
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.warn(`[analytics.quotasBlockages] DB connection issue, returning empty: ${err.message}`);
      const { start, end } = periodFromQuery(req);
      return res.json({ period_start: start, period_end: end, rows: [], degraded: true });
    }
    next(err);
  }
}

/**
 * GET /api/analytics/hierarchy-effectiveness
 * Agrega visitas y conversión a pedido por rol (gerente/supervisor/rep).
 * Permite ver qué nivel jerárquico está siendo más efectivo.
 */
async function hierarchyEffectiveness(req, res, next) {
  try {
    const { start, end } = periodFromQuery(req);
    const desc = await getDescendants(req.user.id);
    if (!desc.length) return res.json({ period_start: start, period_end: end, rows: [] });

    let users = desc;
    if (req.query.poblacion) {
      const inPob = new Set(await poblacion.userIdsInPoblacion(req.query.poblacion));
      users = users.filter((u) => inPob.has(u.id));
    }
    const ids = users.map((u) => u.id);
    if (!ids.length) return res.json({ period_start: start, period_end: end, rows: [] });

    const rows = await db.raw(
      `
      SELECT
        u.role,
        COUNT(DISTINCT v.id)::int AS visits,
        COUNT(DISTINCT v.id) FILTER (WHERE v.order_placed = true)::int AS orders,
        COALESCE(SUM(v.order_amount), 0)::numeric AS order_total,
        COUNT(DISTINCT v.id) FILTER (WHERE COALESCE(p.source,'') <> 'marzam')::int AS visits_new,
        COUNT(DISTINCT v.id) FILTER (WHERE p.source = 'marzam')::int AS visits_existing
      FROM users u
      LEFT JOIN visit_reports v ON v.rep_id = u.id
        AND v.created_at::date BETWEEN ?::date AND ?::date
      LEFT JOIN pharmacies p ON p.id = v.pharmacy_id
      WHERE u.id = ANY(?)
      GROUP BY u.role
      ORDER BY u.role
      `,
      [start, end, ids],
    );

    const out = (rows.rows || rows).map((r) => ({
      role: r.role,
      visits: Number(r.visits) || 0,
      orders: Number(r.orders) || 0,
      order_total: Number(r.order_total) || 0,
      visits_new: Number(r.visits_new) || 0,
      visits_existing: Number(r.visits_existing) || 0,
      conversion_rate: r.visits > 0 ? Number((r.orders / r.visits).toFixed(3)) : 0,
    }));
    res.json({ period_start: start, period_end: end, rows: out });
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.warn(`[analytics.hierarchyEffectiveness] DB issue, returning empty: ${err.message}`);
      const { start, end } = periodFromQuery(req);
      return res.json({ period_start: start, period_end: end, rows: [], degraded: true });
    }
    next(err);
  }
}

/**
 * GET /api/analytics/products-margin
 * Top productos por diferencia (precio_farmacia - precio_marzam) y por volumen.
 * Combina onboarding_products + visit_products.
 */
async function productsMargin(req, res, next) {
  try {
    const { start, end } = periodFromQuery(req);
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const rows = await db.raw(
      `
      WITH all_products AS (
        SELECT op.product_name, op.price_pharmacy, op.price_marzam, ob.created_by AS user_id, ob.created_at
          FROM pharmacy_onboarding_products op
          JOIN pharmacy_onboardings ob ON ob.id = op.onboarding_id
         WHERE op.price_marzam IS NOT NULL AND op.price_pharmacy IS NOT NULL
           AND ob.created_at::date BETWEEN ?::date AND ?::date
        UNION ALL
        SELECT vp.product_name, vp.price_pharmacy, vp.price_marzam, vr.rep_id AS user_id, vr.created_at
          FROM visit_products vp
          JOIN visit_reports vr ON vr.id = vp.visit_id
         WHERE vp.price_marzam IS NOT NULL AND vp.price_pharmacy IS NOT NULL
           AND vr.created_at::date BETWEEN ?::date AND ?::date
      )
      SELECT
        product_name,
        COUNT(*)::int AS samples,
        ROUND(AVG(price_pharmacy)::numeric, 2) AS avg_price_pharmacy,
        ROUND(AVG(price_marzam)::numeric, 2) AS avg_price_marzam,
        ROUND(AVG(price_pharmacy - price_marzam)::numeric, 2) AS avg_margin,
        ROUND(AVG(price_marzam) FILTER (WHERE price_marzam > 0)::numeric, 2) AS avg_marzam_price,
        ROUND(MAX(price_pharmacy - price_marzam)::numeric, 2) AS max_margin,
        ROUND(MIN(price_pharmacy - price_marzam)::numeric, 2) AS min_margin
      FROM all_products
      GROUP BY product_name
      ORDER BY avg_margin DESC NULLS LAST, samples DESC
      LIMIT ?
      `,
      [start, end, start, end, limit],
    );
    res.json({ period_start: start, period_end: end, rows: rows.rows || rows });
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.warn(`[analytics.productsMargin] DB issue, returning empty: ${err.message}`);
      const { start, end } = periodFromQuery(req);
      return res.json({ period_start: start, period_end: end, rows: [], degraded: true });
    }
    next(err);
  }
}

module.exports = { quotasBlockages, hierarchyEffectiveness, productsMargin };
