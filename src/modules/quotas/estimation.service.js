const db = require('../../config/database');
const {
  CADENCE_PER_PARETO,
  MARZAM_PARETOS,
  PROSPECTO_PARETOS,
  MATRIX_COLUMNS,
} = require('../../utils/visitCadence');
const { listKnownPoblaciones, userIdsInPoblacion } = require('../../services/poblacionScope');

const ROLES_ORDER = ['director_sucursal', 'gerente_ventas', 'supervisor', 'representante'];

// ── helpers ──────────────────────────────────────────────────────────────────

async function _getTargetsMap({ branchId = null, channel = 'visit' } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db('visit_targets')
    .where(function () {
      this.where('branch_id', branchId).orWhereNull('branch_id');
    })
    .andWhere('channel', channel)
    .andWhere('is_active', true)
    .andWhere('effective_from', '<=', today)
    .andWhere(function () {
      this.whereNull('effective_to').orWhere('effective_to', '>=', today);
    });

  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.role}|${r.category_kind || 'marzam'}|${r.pareto_class}`;
    const existing = byKey.get(key);
    if (!existing || (existing.branch_id === null && r.branch_id !== null)) {
      byKey.set(key, r);
    }
  }
  return byKey;
}

async function _getCapacityMap(poblacion) {
  const rows = await db('role_capacity_targets').where(function () {
    if (poblacion) this.where('poblacion', poblacion);
    else this.whereNull('poblacion');
  });
  return new Map(rows.map((r) => [r.role, r]));
}

function _dedicatedDays(target, daysPerMonth, totalCols = 7) {
  if (target?.days_share != null) return daysPerMonth * Number(target.days_share) / 100;
  return daysPerMonth / totalCols;
}

function _emptyEstimation(poblacion) {
  return {
    poblacion: poblacion || null,
    total_visits_marzam: 0,
    total_visits_nuevas: 0,
    total_visits: 0,
    coverage_marzam_pct: 0,
    coverage_nuevas_pct: 0,
    avg_frequency_existing: '0.0',
    clients_by_pareto: {},
    prospects_total: 0,
    total_marzam_clients: 0,
    breakdown: [],
  };
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Full coverage estimation for a single poblacion (or global).
 */
async function estimateCoverage({ poblacion = null, branchId = null } = {}) {
  // 1. Targets (4×7 hydrated map)
  const targetsMap = await _getTargetsMap({ branchId });

  // 2. Capacity (days_per_month + target_headcount per role)
  const capacityMap = await _getCapacityMap(poblacion);

  // 3. Real headcount filtered by poblacion
  let userIds = null;
  if (poblacion) {
    userIds = await userIdsInPoblacion(poblacion);
    if (!userIds.length) return _emptyEstimation(poblacion);
  }
  let hcQ = db('users').select(db.raw('role, COUNT(*)::int AS cnt')).where('is_active', true).whereIn('role', ROLES_ORDER);
  if (userIds) hcQ = hcQ.whereIn('id', userIds);
  const hcRows = await hcQ.groupBy('role');
  const realHcByRole = new Map(hcRows.map((r) => [r.role, r.cnt]));

  // 4. Client counts by pareto (filtered by poblacion)
  let clientQ = db('marzam_clients').whereNotNull('pareto').whereIn('pareto', ['A', 'B', 'C']);
  if (poblacion) clientQ = clientQ.where('poblacion', poblacion);
  const clientRows = await clientQ.select(db.raw('pareto, COUNT(*)::int AS cnt')).groupBy('pareto');
  const clientsByPareto = new Map(clientRows.map((r) => [r.pareto, r.cnt]));

  // 5. Prospect counts by quadrant_derived (global — no spatial join for simplicity)
  const prospectRows = await db('pharmacies')
    .whereNot('source', 'marzam')
    .andWhere('status', 'active')
    .whereNotNull('quadrant_derived')
    .select(db.raw('quadrant_derived, COUNT(*)::int AS cnt'))
    .groupBy('quadrant_derived');
  const totalProspects = prospectRows.reduce((s, r) => s + Number(r.cnt), 0);

  // 6. Compute visitas/mes per cell
  let totalMarzam = 0;
  let totalNuevas = 0;
  const breakdown = [];

  for (const role of ROLES_ORDER) {
    const cap = capacityMap.get(role);
    const daysPerMonth = cap?.days_per_month ?? 22;
    const headcount = realHcByRole.get(role) || 0;

    for (const col of MATRIX_COLUMNS) {
      const key = `${role}|${col.category_kind}|${col.pareto_class}`;
      const target = targetsMap.get(key);
      const daily = Number(target?.daily_contacts_per_person ?? 0);
      const dedicated = _dedicatedDays(target, daysPerMonth, MATRIX_COLUMNS.length);
      const monthly = daily * headcount * dedicated;

      if (col.category_kind === 'marzam') totalMarzam += monthly;
      else totalNuevas += monthly;

      breakdown.push({
        role,
        kind: col.category_kind,
        pareto: col.pareto_class,
        daily,
        headcount,
        days_dedicated: Math.round(dedicated * 10) / 10,
        monthly: Math.round(monthly),
      });
    }
  }

  // 7. Coverage denominators
  let marzamNeeded = 0;
  const totalMarzamClients = Array.from(clientsByPareto.values()).reduce((s, v) => s + v, 0);
  for (const [p, cnt] of clientsByPareto) {
    marzamNeeded += cnt * (CADENCE_PER_PARETO[p] || 0);
  }
  const coverageMarzam = marzamNeeded > 0 ? Math.round((totalMarzam / marzamNeeded) * 100) : 0;
  const coverageNuevas = totalProspects > 0 ? Math.round((totalNuevas / totalProspects) * 100) : 0;
  const avgFreq = totalMarzamClients > 0 ? (totalMarzam / totalMarzamClients).toFixed(1) : '0.0';

  return {
    poblacion: poblacion || null,
    total_visits_marzam: Math.round(totalMarzam),
    total_visits_nuevas: Math.round(totalNuevas),
    total_visits: Math.round(totalMarzam + totalNuevas),
    coverage_marzam_pct: coverageMarzam,
    coverage_nuevas_pct: coverageNuevas,
    avg_frequency_existing: avgFreq,
    clients_by_pareto: Object.fromEntries(clientsByPareto),
    total_marzam_clients: totalMarzamClients,
    prospects_total: totalProspects,
    breakdown,
  };
}

/**
 * Per-poblacion summary. Uses bulk DB queries to avoid N+1.
 */
async function estimateByPoblacion({ branchId = null } = {}) {
  const poblaciones = await listKnownPoblaciones();
  if (!poblaciones.length) return [];

  const targetsMap = await _getTargetsMap({ branchId });

  // Bulk: clients grouped by poblacion + pareto
  const allClients = await db('marzam_clients')
    .whereNotNull('pareto').whereIn('pareto', ['A', 'B', 'C'])
    .whereNotNull('poblacion')
    .select(db.raw('poblacion, pareto, COUNT(*)::int AS cnt'))
    .groupBy('poblacion', 'pareto');

  const clientsByPob = new Map();
  for (const r of allClients) {
    if (!clientsByPob.has(r.poblacion)) clientsByPob.set(r.poblacion, new Map());
    clientsByPob.get(r.poblacion).set(r.pareto, r.cnt);
  }

  // Bulk: saved targets grouped by poblacion
  const allCap = await db('role_capacity_targets');
  const capByPob = new Map();
  for (const r of allCap) {
    const k = r.poblacion || '__global__';
    if (!capByPob.has(k)) capByPob.set(k, new Map());
    capByPob.get(k).set(r.role, r);
  }

  return poblaciones.map((pob) => {
    const clients = clientsByPob.get(pob) || new Map();
    const totalClients = Array.from(clients.values()).reduce((s, v) => s + v, 0);
    const capMap = capByPob.get(pob) || capByPob.get('__global__') || new Map();

    // Estimate needed visits (Marzam)
    let marzamNeeded = 0;
    for (const [p, cnt] of clients) marzamNeeded += cnt * (CADENCE_PER_PARETO[p] || 0);

    // Recommended reps: ceil(C-slots-needed / (rep-C-daily × days))
    const repCap = capMap.get('representante');
    const daysPerMonth = repCap?.days_per_month ?? 22;
    const repCKey = 'representante|marzam|C';
    const repCDaily = Number(targetsMap.get(repCKey)?.daily_contacts_per_person ?? 0);
    const cClients = clients.get('C') || 0;
    const repsRecommended = repCDaily > 0
      ? Math.ceil((cClients * CADENCE_PER_PARETO.C) / (repCDaily * daysPerMonth / 7))
      : 0;
    const repsTarget = repCap?.target_headcount ?? 0;

    return {
      poblacion: pob,
      clients_a: clients.get('A') || 0,
      clients_b: clients.get('B') || 0,
      clients_c: clients.get('C') || 0,
      total_clients: totalClients,
      visits_needed: Math.round(marzamNeeded),
      reps_target: repsTarget,
      reps_recommended: repsRecommended,
      gap: Math.max(0, repsRecommended - repsTarget),
    };
  });
}

/**
 * Headcount recommendations for a specific poblacion.
 */
async function recommendHeadcount({ poblacion = null, branchId = null } = {}) {
  const targetsMap = await _getTargetsMap({ branchId });
  const capacityMap = await _getCapacityMap(poblacion);

  let clientQ = db('marzam_clients').whereNotNull('pareto').whereIn('pareto', ['A', 'B', 'C']);
  if (poblacion) clientQ = clientQ.where('poblacion', poblacion);
  const clientRows = await clientQ.select(db.raw('pareto, COUNT(*)::int AS cnt')).groupBy('pareto');
  const clientsByPareto = new Map(clientRows.map((r) => [r.pareto, r.cnt]));

  const recommendations = {};
  for (const role of ROLES_ORDER) {
    const cap = capacityMap.get(role);
    const daysPerMonth = cap?.days_per_month ?? 22;
    let maxNeeded = 0;
    const byPareto = {};

    for (const p of MARZAM_PARETOS) {
      const daily = Number(targetsMap.get(`${role}|marzam|${p}`)?.daily_contacts_per_person ?? 0);
      if (!daily) { byPareto[p] = 0; continue; }
      const needed = (clientsByPareto.get(p) || 0) * (CADENCE_PER_PARETO[p] || 0);
      const recs = Math.ceil(needed / (daily * daysPerMonth / 7));
      byPareto[p] = recs;
      if (recs > maxNeeded) maxNeeded = recs;
    }

    recommendations[role] = {
      role,
      days_per_month: daysPerMonth,
      recommended_headcount: maxNeeded,
      breakdown_by_pareto: byPareto,
    };
  }

  return recommendations;
}

module.exports = {
  estimateCoverage,
  estimateByPoblacion,
  recommendHeadcount,
};
