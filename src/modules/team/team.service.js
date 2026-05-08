const db = require('../../config/database');
const { getTeamCascade, getDirectReports, canActorManage } = require('../../services/teamScope');
const { ROLES } = require('../../constants/roles');
const marzamReadonly = require('../marzam-readonly/marzam.service');
const { getMarzamSourceDb } = require('../../integrations/marzamSource/client');

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
  // Single source of truth: the same enriched code-based hierarchy that
  // the Plan Editor uses. This guarantees Mi Equipo and Plan Editor always
  // see the same set of users (gerentes + supervisores + reps + VACANTEs)
  // regardless of whether `users.manager_id` is populated.
  const descendants = await getDescendantsEnriched({ userId, actor });
  if (!descendants.length) return { descendants: [], by_role: {} };

  // Attach metrics by UUID where available (synthetic ids won't match).
  const realIds = descendants.filter((d) => !d.synthetic_id).map((d) => d.id);
  let metrics = {};
  try {
    metrics = await getMetricsForUsers(realIds, { dateFrom, dateTo });
  } catch (err) {
    if (!/relation "visit_plan_assignments" does not exist/.test(String(err.message || ''))) {
      throw err;
    }
  }
  const enriched = descendants.map((u) => ({
    ...u,
    metrics: metrics[u.id] || { planned: 0, done: 0, compliance_pct: null },
  }));

  // Group by role for callers that prefer the by_role shape.
  const byRole = {};
  for (const u of enriched) {
    if (!byRole[u.role]) byRole[u.role] = [];
    byRole[u.role].push(u);
  }
  return { descendants: enriched, by_role: byRole };
}

// Cache: do `users.home_lat/etc.` columns exist? Set on first call.
let _hasRoutingCols = null;

async function detectRoutingColumns() {
  if (_hasRoutingCols !== null) return _hasRoutingCols;
  try {
    await db.raw(`SELECT home_lat FROM users LIMIT 0`);
    _hasRoutingCols = true;
  } catch {
    _hasRoutingCols = false;
  }
  return _hasRoutingCols;
}

/**
 * Code-based hierarchy convention (verified with stakeholder 2026-04-29):
 *
 *   - Director:    no aparece en cuadro_basico — branch-wide visibility.
 *   - Gerente:     employee_code = gerencia_code (e.g. 'UE').
 *   - Supervisor:  employee_code = supervisor_code + '00' (e.g. 'UEA00').
 *   - Representante: employee_code = supervisor_code + 2 digits (e.g. 'UEA01'),
 *                  where the 2 digits are NOT '00'.
 *
 * Returns the parent's employee_code given a child:
 *   - rep:        first 3 letters of employee_code + '00'  → supervisor's code
 *   - supervisor: first 2 letters of employee_code         → gerente's code
 *   - gerente:    null
 */
function parentCodeOf(entry) {
  const code = entry.employee_code;
  if (!code) return null;
  if (entry.role === ROLES.REPRESENTANTE) {
    if (code.length >= 5) return code.slice(0, 3) + '00';
    return null;
  }
  if (entry.role === ROLES.SUPERVISOR) {
    if (code.length >= 2) return code.slice(0, 2);
    return null;
  }
  return null;
}

/**
 * Flat list of descendants for the Plan Editor's hierarchical picker.
 *
 * Builds the hierarchy from `marzam-readonly.getRepresentatives()` (the
 * canonical code-based source: UE / UEA00 / UEAXX) so it works even when
 * `users.manager_id` is sparse or null.  Then enriches each row with the
 * matching `users.id` (real UUID for selection), home_lat/lng (when
 * migration 057 is applied), and `employee_profiles.domicilio_particular`.
 *
 * Includes ALL roles below the actor (gerentes + supervisors + reps), not
 * just reps — Pareto A visits go to gerentes, Pareto B to supervisors.
 */
async function getDescendantsEnriched({ userId: _userId, actor }) {
  if (!actor) return [];
  // 1. Build the canonical hierarchy from marzam-readonly.
  let descendants = [];
  try {
    descendants = await buildFallbackCascade(actor).then((c) => c.descendants);
  } catch (err) {
    console.warn(`[team.descendants] readonly cascade failed: ${err.message}`);
    return [];
  }
  if (!descendants.length) return [];

  // 2. Enrich with `users` table data when present. Defensive against:
  //    - `users` table missing (bootstrap window)
  //    - migration 057 not yet applied (no home_lat / home_lng / etc.)
  const empCodes = descendants.map((d) => d.employee_code).filter(Boolean);
  const userRowsByCode = new Map();
  const userRowsById = new Map();
  if (empCodes.length) {
    const hasRouting = await detectRoutingColumns();
    const baseSelect = [
      'users.id', 'users.employee_code', 'users.is_active',
      'users.email', 'users.branch_id',
      'b.name as branch_name', 'b.code as branch_code',
      'ep.domicilio_particular', 'ep.zona_poblaciones', 'ep.rango',
    ];
    if (hasRouting) {
      baseSelect.push(
        'users.home_lat', 'users.home_lng',
        'users.daily_minutes_cap', 'users.service_minutes_per_stop',
      );
    }
    try {
      const rows = await db('users')
        .leftJoin('branches as b', 'b.id', 'users.branch_id')
        .leftJoin('employee_profiles as ep', 'ep.user_id', 'users.id')
        .whereIn('users.employee_code', empCodes)
        .select(baseSelect);
      for (const r of rows) {
        userRowsByCode.set(r.employee_code, r);
        userRowsById.set(r.id, r);
      }
    } catch (err) {
      console.warn(`[team.descendants] users enrichment skipped: ${err.message}`);
    }
  }

  // 3. Compose final rows. We preserve the rich fields from marzam-readonly
  //    (agente_code, supervisor_code, gerencia_code, clave_cuadro_basico,
  //    poblacion, zona, profile.*) so the FE can render the chain badges
  //    UE › UEA › UEA01 the same way for Plan Editor and Mi Equipo. We
  //    layer on top the `users` row data when present (real UUID, home,
  //    daily_minutes_cap, branch_name).
  const composed = descendants.map((d) => {
    const u = userRowsByCode.get(d.employee_code);
    const id = u?.id || `code:${d.employee_code}`;
    return {
      ...d, // agente_code, supervisor_code, gerencia_code, manager_code,
            // clave_cuadro_basico, poblacion, zona, profile, etc.
      id,
      synthetic_id: !u?.id,
      email: u?.email || d.email || null,
      is_active: u ? u.is_active !== false : true,
      // Hierarchy via code convention (computed, used for parent resolution).
      _parent_code: parentCodeOf(d),
      // Branch
      branch_id: u?.branch_id || null,
      branch_code: u?.branch_code || d.branch_code || null,
      branch_name: u?.branch_name || d.branch_name || null,
      // Profile
      zona_poblaciones: u?.zona_poblaciones || d.poblacion || null,
      rango: u?.rango || null,
      domicilio_particular: u?.domicilio_particular || d.profile?.domicilio || null,
      // Routing
      home_lat: u?.home_lat ?? null,
      home_lng: u?.home_lng ?? null,
      daily_minutes_cap: u?.daily_minutes_cap || 480,
      service_minutes_per_stop: u?.service_minutes_per_stop || 45,
      has_home: u?.home_lat != null && u?.home_lng != null,
      has_address: !!(u?.domicilio_particular || d.profile?.domicilio),
    };
  });

  // 4. Resolve `_parent_code` to the parent's `id` (UUID when possible).
  //    Fallback chain: if the direct parent doesn't exist (e.g. supervisor
  //    row absent), climb one more level — a rep without a supervisor row
  //    falls under the gerente; a supervisor without a gerente row stays
  //    ungrouped. This matches the user's mental model: "if there is no
  //    supervisor, the next one in line is the gerente".
  const byCode = new Map(composed.map((c) => [c.employee_code, c]));
  for (const c of composed) {
    let parent = c._parent_code ? byCode.get(c._parent_code) : null;
    if (!parent && c.role === ROLES.REPRESENTANTE && c.employee_code?.length >= 2) {
      parent = byCode.get(c.employee_code.slice(0, 2)) || null;
    }
    c.manager_id = parent?.id || null;
    c.manager_employee_code = parent?.employee_code || null;
    c.manager_name = parent?.full_name || null;
    c.manager_role = parent?.role || null;
    delete c._parent_code;
  }

  // 5. Attach `poblaciones`: the distinct set of `marzam_clients.poblacion`
  //    values that each user actually serves through their assignments.
  //    This is the canonical "Entidad Federativa" link in the UI — what the
  //    rep is responsible for, derived from the work itself, not from a
  //    self-reported zone field. A rep gets the poblaciones of clients
  //    where assigned_rep_id = his id; a supervisor gets the union of
  //    assigned_supervisor_id; a gerente, assigned_gerente_id.
  try {
    const realIds = composed.filter((c) => !c.synthetic_id).map((c) => c.id);
    if (realIds.length) {
      const rows = await db.raw(`
        SELECT user_id, ARRAY_AGG(DISTINCT poblacion ORDER BY poblacion) AS poblaciones
        FROM (
          SELECT assigned_rep_id        AS user_id, poblacion FROM marzam_clients WHERE assigned_rep_id        = ANY (?::uuid[]) AND poblacion IS NOT NULL AND poblacion <> ''
          UNION ALL
          SELECT assigned_supervisor_id AS user_id, poblacion FROM marzam_clients WHERE assigned_supervisor_id = ANY (?::uuid[]) AND poblacion IS NOT NULL AND poblacion <> ''
          UNION ALL
          SELECT assigned_gerente_id    AS user_id, poblacion FROM marzam_clients WHERE assigned_gerente_id    = ANY (?::uuid[]) AND poblacion IS NOT NULL AND poblacion <> ''
        ) t
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      `, [realIds, realIds, realIds]);
      const polByUser = new Map();
      for (const r of rows.rows) polByUser.set(r.user_id, r.poblaciones || []);
      for (const c of composed) c.poblaciones = polByUser.get(c.id) || [];
    } else {
      for (const c of composed) c.poblaciones = [];
    }

    // Fallback: if marzam_clients.assigned_*_id is not yet populated (all empty),
    // derive poblaciones from detalle_mostrador by employee_code matching.
    // This covers the interim state before the client-assignment sync runs.
    const anyPopulated = composed.some((c) => c.poblaciones && c.poblaciones.length > 0);
    if (!anyPopulated) {
      const srcDb = getMarzamSourceDb();
      // Build a code→poblaciones map from detalle_mostrador covering:
      //   - reps       : agente column      (e.g. 'UEA03')
      //   - supervisors: LEFT(agente,3)+'00' (e.g. 'UEA00')
      //   - gerentes   : gerencia column    (e.g. 'UE') — use direct column,
      //                  not LEFT(agente,2), to handle any non-standard codes.
      const { rows: srcRows } = await srcDb.raw(`
        SELECT code, poblacion FROM (
          SELECT DISTINCT agente                AS code, poblacion FROM staging.stg_marzam_detalle_mostrador WHERE agente    IS NOT NULL AND poblacion IS NOT NULL AND TRIM(poblacion) <> ''
          UNION ALL
          SELECT DISTINCT LEFT(agente,3)||'00'  AS code, poblacion FROM staging.stg_marzam_detalle_mostrador WHERE agente    IS NOT NULL AND poblacion IS NOT NULL AND TRIM(poblacion) <> ''
          UNION ALL
          SELECT DISTINCT gerencia              AS code, poblacion FROM staging.stg_marzam_detalle_mostrador WHERE gerencia  IS NOT NULL AND poblacion IS NOT NULL AND TRIM(poblacion) <> '' AND LENGTH(TRIM(gerencia)) = 2
        ) t
        WHERE code IS NOT NULL
      `);
      const polByCode = new Map();
      for (const r of srcRows) {
        const code = String(r.code || '').trim().toUpperCase();
        if (!code) continue;
        if (!polByCode.has(code)) polByCode.set(code, new Set());
        polByCode.get(code).add(r.poblacion);
      }
      for (const c of composed) {
        const code = String(c.employee_code || '').trim().toUpperCase();
        if (polByCode.has(code)) {
          c.poblaciones = [...polByCode.get(code)].sort();
        }
      }
    }
  } catch (err) {
    // Soft-fail: UI won't filter by zone but won't crash.
    console.warn(`[team.descendants] poblaciones enrichment skipped: ${err.message}`);
    for (const c of composed) if (!c.poblaciones) c.poblaciones = [];
  }

  return composed;
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
  getDescendantsEnriched,
};
