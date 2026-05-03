/**
 * Plan generator.
 *
 * Inputs a window (period_start..period_end), a granularity, and a list of
 * scope_user_ids. Produces a `visit_plans` row plus N `visit_plan_assignments`
 * rows distributed across the working days in the window.
 *
 * Algorithm (greedy + fairness):
 *   1) For each scope user × pareto class, resolve daily target via SQL func
 *      `resolve_visit_target(user_id, pareto, channel, day)`.
 *   2) Pick candidate marzam_clients (filtered by branch / Ecatepec / pareto)
 *      not yet assigned to another published, overlapping plan.
 *   3) For PARETO C, additionally pick prospects from `pharmacies` (rows with
 *      `source <> 'marzam'`).  Reglas de negocio (Apr-30):
 *        - Las nuevas se tratan como C → solo supervisor + representante.
 *        - Se llenan PRIMERO los clientes existentes; los slots remanentes
 *          de C se topean con prospectos ordenados por quadrant (Q1 mejor).
 *        - El plan resultante mezcla ambos tipos en `visit_plan_assignments`
 *          usando la columna `pharmacy_id` (post-migración 050) para
 *          prospectos y `marzam_client_id` para clientes.
 *   4) Distribute farmacias per (visitor, day) round-robin within their pareto
 *      class until daily target is hit or candidates run out.
 *   5) Snapshot the resolved targets in `visit_plans.config.targets_snapshot`
 *      so a mid-period target change does not rewrite this plan silently.
 */

const db = require('../../config/database');
const { ROLES, normalizeRole } = require('../../constants/roles');
const { canActorManage } = require('../../services/teamScope');

const PARETO_CLASSES = ['A', 'B', 'C'];

// Default mapping pareto → primary visitor role. Used to drop a user from
// consideration for a pareto class their role isn't naturally responsible for
// (a representante is not pre-distributed clients A unless explicitly chosen).
//
// Por regla acordada Apr-30, los prospectos (farmacias nuevas) se tratan como
// 'C' y por tanto los visitan supervisor + representante; gerente y director
// quedan deliberadamente fuera de la prospección.
const ROLE_PRIMARY_PARETO = {
  [ROLES.DIRECTOR_SUCURSAL]: ['A'],
  [ROLES.GERENTE_VENTAS]: ['A', 'B'],
  [ROLES.SUPERVISOR]: ['B', 'C'],
  [ROLES.REPRESENTANTE]: ['C'],
};

// Roles que pueden recibir prospectos en su plan diario.  Se usa para
// evitar que un cambio futuro en ROLE_PRIMARY_PARETO (p.ej. dar 'C' a
// gerentes en una sucursal piloto) abra la puerta a la prospección por
// roles que el negocio no quiere ahí.
const ROLES_THAT_PROSPECT = new Set([ROLES.SUPERVISOR, ROLES.REPRESENTANTE]);

function isWeekday(date) {
  const d = date.getUTCDay();
  return d !== 0 && d !== 6; // Sun=0, Sat=6
}

function eachWorkingDay(start, end) {
  const days = [];
  const cursor = new Date(start);
  const stop = new Date(end);
  while (cursor <= stop) {
    if (isWeekday(cursor)) days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function resolveTargetsForUser(trx, userId, day) {
  const out = {};
  for (const pareto of PARETO_CLASSES) {
    const r = await trx.raw('SELECT resolve_visit_target(?, ?::char(1), ?, ?::date) AS v', [
      userId, pareto, 'visit', day,
    ]);
    out[pareto] = r.rows?.[0]?.v ?? null;
  }
  return out;
}

async function pickCandidateClients(trx, { branchId, paretoFilter, excludeClientIds = [] }) {
  // Pull all active marzam_clients matching pareto. Branch filter is best-
  // effort: marzam_clients doesn't carry branch_id, so we let the caller
  // restrict by territory/poblacion in a later iteration. For now, branch is
  // inferred via the visitors' branch only.
  const q = trx('marzam_clients')
    .select('id', 'cpadre', 'pareto', 'pharmacy_id', 'farmacia_nombre', 'delegacion_municipio', 'poblacion')
    .whereNotNull('pareto');
  if (paretoFilter?.length) q.whereIn('pareto', paretoFilter);
  if (excludeClientIds.length) q.whereNotIn('id', excludeClientIds);
  if (branchId) {
    // soft branch filter: include all + tag (no-op until poblacion↔branch mapping lands)
  }
  return q.orderByRaw("CASE pareto WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 ELSE 4 END, cpadre");
}

/**
 * Prospectos = farmacias en el universo BlackPrint que NO son cliente Marzam.
 * Los priorizamos por quadrant (Q1 = mayor potencial) y final_score desc, así
 * el plan empuja primero a los reps a las farmacias con mejor potencial.
 *
 * Filtros duros:
 *   - source <> 'marzam'   (no son cliente)
 *   - status = 'active'    (no cerradas/duplicadas/inválidas)
 *   - business_type IS NULL OR 'pharmacy'  (no consultorios)
 *   - excluyendo las ya asignadas a otro plan publicado del mismo periodo
 */
async function pickCandidateProspects(trx, { branchId, excludePharmacyIds = [] }) {
  void branchId; // mismo soft-filter pendiente que para clientes
  const q = trx('pharmacies')
    .select('id', 'name as farmacia_nombre', 'municipality as delegacion_municipio', 'quadrant', 'final_score')
    .whereNot('source', 'marzam')
    .andWhere('status', 'active')
    .andWhere(function () {
      this.whereNull('business_type').orWhere('business_type', 'pharmacy');
    });
  if (excludePharmacyIds.length) q.whereNotIn('id', excludePharmacyIds);
  return q.orderByRaw(`
    CASE quadrant
      WHEN 'Q1' THEN 1 WHEN 'Q2' THEN 2 WHEN 'Q3' THEN 3 WHEN 'Q4' THEN 4 ELSE 5
    END,
    COALESCE(final_score, 0) DESC,
    name
  `);
}

async function loadAlreadyAssignedClientIds(trx, periodStart, periodEnd) {
  const rows = await trx('visit_plan_assignments as vpa')
    .join('visit_plans as vp', 'vp.id', 'vpa.visit_plan_id')
    .where('vp.status', 'published')
    .andWhere('vpa.scheduled_date', '>=', periodStart)
    .andWhere('vpa.scheduled_date', '<=', periodEnd)
    .whereNotNull('vpa.marzam_client_id')
    .pluck('vpa.marzam_client_id');
  return rows;
}

async function loadAlreadyAssignedPharmacyIds(trx, periodStart, periodEnd) {
  const rows = await trx('visit_plan_assignments as vpa')
    .join('visit_plans as vp', 'vp.id', 'vpa.visit_plan_id')
    .where('vp.status', 'published')
    .andWhere('vpa.scheduled_date', '>=', periodStart)
    .andWhere('vpa.scheduled_date', '<=', periodEnd)
    .whereNotNull('vpa.pharmacy_id')
    .pluck('vpa.pharmacy_id');
  return rows;
}

/**
 * Build the assignments matrix. Returns the rows ready for INSERT into
 * `visit_plan_assignments`.
 *
 * Para cada (usuario, día):
 *   - Itera sus PARETOs permitidos (ROLE_PRIMARY_PARETO).
 *   - Para PARETO C: llena PRIMERO con clientes existentes del pool C; si
 *     queda cupo y el rol prospecta, topa con el pool de prospectos.
 *   - Para PARETO A/B: solo clientes existentes (no aplica prospección).
 *
 * Cada candidato lleva un campo `__type` ('client' | 'prospect') que decide
 * si se materializa con `marzam_client_id` o con `pharmacy_id` en el INSERT.
 */
function buildAssignments({ scopeUsers, days, candidatesByPareto, prospects, targets }) {
  const rows = [];
  const usedClients = new Set();
  const usedProspects = new Set();

  for (const day of days) {
    const dayIso = isoDate(day);
    for (const u of scopeUsers) {
      const userTargets = targets[u.id] || {};
      const role = normalizeRole(u.role);
      const allowedParetos = ROLE_PRIMARY_PARETO[role] || [];
      let order = 1;

      for (const pareto of allowedParetos) {
        const dailyTarget = userTargets[pareto] || 0;
        if (!dailyTarget) continue;

        let placed = 0;
        const clientPool = candidatesByPareto[pareto] || [];

        // Fase 1: clientes existentes del PARETO.
        for (let i = 0; i < clientPool.length && placed < dailyTarget; i += 1) {
          const candidate = clientPool[i];
          if (usedClients.has(candidate.id)) continue;
          rows.push({
            visitor_user_id: u.id,
            marzam_client_id: candidate.id,
            pharmacy_id: null,
            scheduled_date: dayIso,
            route_order: order,
            channel: 'visit',
            status: 'planned',
          });
          usedClients.add(candidate.id);
          order += 1;
          placed += 1;
        }

        // Fase 2: solo si es PARETO C y el rol prospecta — topear con prospectos.
        if (pareto === 'C' && placed < dailyTarget && ROLES_THAT_PROSPECT.has(role)) {
          for (let i = 0; i < prospects.length && placed < dailyTarget; i += 1) {
            const candidate = prospects[i];
            if (usedProspects.has(candidate.id)) continue;
            rows.push({
              visitor_user_id: u.id,
              marzam_client_id: null,
              pharmacy_id: candidate.id,
              scheduled_date: dayIso,
              route_order: order,
              channel: 'visit',
              status: 'planned',
            });
            usedProspects.add(candidate.id);
            order += 1;
            placed += 1;
          }
        }
      }
    }
  }

  return rows;
}

/**
 * Generate a plan.
 *
 * @param {object} args
 * @param {string} args.ownerUserId       — quien genera (firma del plan)
 * @param {string[]} args.scopeUserIds    — users que ejecutan el plan
 * @param {'daily'|'weekly'|'monthly'} args.granularity
 * @param {string} args.periodStart       — ISO date
 * @param {string} args.periodEnd         — ISO date
 * @param {string[]} [args.paretoFilter]  — restringe a A/B/C
 * @param {string|null} [args.branchId]
 * @param {string} [args.name]
 */
async function generate({
  ownerUserId,
  scopeUserIds,
  granularity,
  periodStart,
  periodEnd,
  paretoFilter = PARETO_CLASSES,
  branchId = null,
  name = null,
}) {
  if (!Array.isArray(scopeUserIds) || !scopeUserIds.length) {
    const err = new Error('scopeUserIds is required');
    err.status = 400;
    throw err;
  }
  if (!['daily', 'weekly', 'monthly'].includes(granularity)) {
    const err = new Error('granularity must be daily/weekly/monthly');
    err.status = 400;
    throw err;
  }

  // Authorization — every scope_user must be the owner himself OR a managee.
  for (const sid of scopeUserIds) {
    if (sid === ownerUserId) continue;
    if (!await canActorManage(ownerUserId, sid)) {
      const err = new Error(`User ${ownerUserId} cannot generate plan for ${sid}`);
      err.status = 403;
      throw err;
    }
  }

  return db.transaction(async (trx) => {
    const scopeUsers = await trx('users')
      .select('id', 'role', 'full_name', 'branch_id')
      .whereIn('id', scopeUserIds)
      .andWhere({ is_active: true });

    const days = eachWorkingDay(new Date(`${periodStart}T00:00:00Z`), new Date(`${periodEnd}T00:00:00Z`));
    if (!days.length) {
      const err = new Error('No working days in window');
      err.status = 400;
      throw err;
    }

    // Resolve targets per user per pareto (snapshot from day 1 of the window).
    const firstDay = isoDate(days[0]);
    const targets = {};
    for (const u of scopeUsers) {
      targets[u.id] = await resolveTargetsForUser(trx, u.id, firstDay);
    }

    // Candidate clients (avoid double-booking against already-published plans).
    const alreadyAssignedClients = await loadAlreadyAssignedClientIds(trx, periodStart, periodEnd);
    const allCandidates = await pickCandidateClients(trx, {
      branchId,
      paretoFilter,
      excludeClientIds: alreadyAssignedClients,
    });
    const candidatesByPareto = { A: [], B: [], C: [] };
    for (const c of allCandidates) {
      if (candidatesByPareto[c.pareto]) candidatesByPareto[c.pareto].push(c);
    }

    // Prospectos solo se cargan si en el scope hay alguien que prospecta y
    // PARETO C está dentro del filtro.  Esto evita un query inútil cuando
    // el plan se regenera para un director o un gerente.
    const willPickProspects = paretoFilter.includes('C')
      && scopeUsers.some((u) => ROLES_THAT_PROSPECT.has(normalizeRole(u.role)));
    let prospects = [];
    if (willPickProspects) {
      const alreadyAssignedProspects = await loadAlreadyAssignedPharmacyIds(trx, periodStart, periodEnd);
      prospects = await pickCandidateProspects(trx, {
        branchId,
        excludePharmacyIds: alreadyAssignedProspects,
      });
    }

    const assignmentRows = buildAssignments({
      scopeUsers,
      days,
      candidatesByPareto,
      prospects,
      targets,
    });

    const config = {
      targets_snapshot: targets,
      working_days: days.length,
      pareto_filter: paretoFilter,
      candidate_counts: {
        A: candidatesByPareto.A.length,
        B: candidatesByPareto.B.length,
        C: candidatesByPareto.C.length,
        prospects: prospects.length,
      },
    };

    const [plan] = await trx('visit_plans')
      .insert({
        owner_user_id: ownerUserId,
        scope_user_id: scopeUserIds.length === 1 ? scopeUserIds[0] : null,
        branch_id: branchId,
        granularity,
        period_start: periodStart,
        period_end: periodEnd,
        status: 'draft',
        name,
        config,
      })
      .returning('*');

    if (assignmentRows.length) {
      const insertRows = assignmentRows.map((r) => ({ ...r, visit_plan_id: plan.id }));
      // chunk-insert to keep parameter count under 1000
      const CHUNK = 250;
      for (let i = 0; i < insertRows.length; i += CHUNK) {
        await trx('visit_plan_assignments').insert(insertRows.slice(i, i + CHUNK));
      }
    }

    return {
      plan,
      assignments_count: assignmentRows.length,
    };
  });
}

module.exports = {
  generate,
  PARETO_CLASSES,
  ROLE_PRIMARY_PARETO,
};
