const db = require('../../config/database');
const externalPoiRepository = require('../../repositories/external/poiRepository');
const externalFieldSurveyRepository = require('../../repositories/external/fieldSurveyRepository');
const externalDeviceLocationRepository = require('../../repositories/external/deviceLocationRepository');
const { isExternalDataMode } = require('../../repositories/runtime');
const { resolveEvidenceAccessUrl } = require('../../utils/gcsEvidence');
const accessDirectory = require('../../services/accessDirectory');
const { getDataScope, getUserScope } = require('../../middleware/requestContext');
const { applyTerritoryFilter, isScopeFilteringEnabled } = require('../../middleware/scopeFilter');

function applyPharmacyScope(q, column = 'pharmacies.territory_id') {
  return applyTerritoryFilter(q, column, getUserScope());
}

async function getRepNameMap() {
  if (isExternalDataMode()) {
    return new Map(accessDirectory.listFieldRepsByScope(getDataScope()).map((user) => [String(user.id), user.full_name]));
  }
  const reps = await db('users')
    .select('id', 'full_name')
    .where({ role: 'field_rep', is_active: true });
  return new Map(reps.map((row) => [String(row.id), row.full_name]));
}

async function getExternalDashboardData() {
  const [poiRows, currentRows, locationRows, repNameMap] = await Promise.all([
    externalPoiRepository.list({ limit: 5000 }),
    externalFieldSurveyRepository.listCurrentState({ limit: 20000 }),
    externalDeviceLocationRepository.listLocations(10000),
    getRepNameMap(),
  ]);
  return { poiRows, currentRows, locationRows, repNameMap };
}

async function refreshViews() {
  if (isExternalDataMode()) {
    return;
  }

  await db.raw('REFRESH MATERIALIZED VIEW mv_pharmacy_funnel');
  await db.raw('REFRESH MATERIALIZED VIEW mv_rep_productivity');
  await db.raw('REFRESH MATERIALIZED VIEW mv_coverage_by_municipality');
  await db.raw('REFRESH MATERIALIZED VIEW mv_assignment_progress');
  await db.raw('REFRESH MATERIALIZED VIEW mv_potential_sales');
}

async function getPharmacyFunnel() {
  if (isExternalDataMode()) {
    const { poiRows, currentRows } = await getExternalDashboardData();
    const currentByPharmacy = new Map(currentRows.map((row) => [String(row.pharmacy_id), row]));
    const total = poiRows.length;
    const assigned = poiRows.filter((row) => {
      const current = currentByPharmacy.get(String(row.id));
      return current && ['assigned', 'in_progress', 'reassigned', 'completed'].includes(current.assignment_status);
    }).length;
    const visited = poiRows.filter((row) => {
      const current = currentByPharmacy.get(String(row.id));
      return current && !!current.visited_at;
    }).length;
    const interested = currentRows.filter((row) => row.visit_status === 'interested').length;
    const needs_follow_up = currentRows.filter((row) => row.visit_status === 'follow_up_required').length;
    const invalid_closed = currentRows.filter((row) => ['closed', 'invalid', 'duplicate', 'moved', 'wrong_category', 'chain_not_independent'].includes(row.visit_status)).length;
    const contact_made = currentRows.filter((row) => row.visit_status === 'contact_made').length;
    return {
      total_pharmacies: total,
      assigned,
      visited,
      interested,
      needs_follow_up,
      invalid_closed,
      contact_made,
      coverage_pct: total > 0 ? Number(((visited * 100) / total).toFixed(1)) : 0,
    };
  }

  const q = db('pharmacies')
    .select(
      db.raw(`count(*) FILTER (WHERE is_independent = true) AS total_pharmacies`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND assigned_rep_id IS NOT NULL) AS assigned`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND last_visited_at IS NOT NULL) AS visited`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND last_visit_outcome = 'interested') AS interested`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND last_visit_outcome = 'needs_follow_up') AS needs_follow_up`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND status IN ('closed','invalid','duplicate','moved')) AS invalid_closed`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND last_visit_outcome = 'contact_made') AS contact_made`),
    )
    .where(function () {
      this.whereNull('colonia_id')
        .orWhereNotIn('colonia_id', function () {
          this.select('id').from('colonias').where('security_level', 'not_acceptable');
        });
    });
  applyPharmacyScope(q, 'pharmacies.territory_id');
  const rows = await q;
  const funnel = rows[0] || {};
  const total = Number(funnel.total_pharmacies || 0);
  const visited = Number(funnel.visited || 0);
  funnel.coverage_pct = total > 0 ? Number(((visited * 100) / total).toFixed(1)) : 0;
  return funnel;
}

async function getRepProductivity() {
  if (isExternalDataMode()) {
    const { currentRows, repNameMap } = await getExternalDashboardData();
    const byRep = new Map();

    const allReps = accessDirectory.listFieldRepsByScope(getDataScope());
    for (const rep of allReps) {
      byRep.set(String(rep.id), {
        rep_id: String(rep.id),
        rep_name: rep.full_name,
        total_visits: 0,
        unique_pharmacies_visited: 0,
        interested_count: 0,
        follow_up_count: 0,
        assigned_total: 0,
        completed_total: 0,
        with_photo_total: 0,
        with_comment_total: 0,
        regularization_follow_up_total: 0,
        first_visit: null,
        last_visit: null,
      });
    }

    for (const row of currentRows) {
      if (!row.rep_id) continue;
      if (!byRep.has(row.rep_id)) {
        byRep.set(row.rep_id, {
          rep_id: row.rep_id,
          rep_name: row.rep_name || repNameMap.get(String(row.rep_id)) || null,
          total_visits: 0,
          unique_pharmacies_visited: 0,
          interested_count: 0,
          follow_up_count: 0,
          assigned_total: 0,
          completed_total: 0,
          with_photo_total: 0,
          with_comment_total: 0,
          regularization_follow_up_total: 0,
          first_visit: null,
          last_visit: null,
        });
      }

      const summary = byRep.get(row.rep_id);
      summary.assigned_total += 1;
      if (row.visited_at) {
        summary.total_visits += 1;
        summary.unique_pharmacies_visited += 1;
        if (!summary.first_visit || new Date(row.visited_at) < new Date(summary.first_visit)) summary.first_visit = row.visited_at;
        if (!summary.last_visit || new Date(row.visited_at) > new Date(summary.last_visit)) summary.last_visit = row.visited_at;
      }
      if (row.assignment_status === 'completed') summary.completed_total += 1;
      if (row.visit_status === 'interested') summary.interested_count += 1;
      if (row.visit_status === 'follow_up_required') summary.follow_up_count += 1;
      if (row.photo_url) summary.with_photo_total += 1;
      if (String(row.comment || '').trim()) summary.with_comment_total += 1;
      if (row.regularization_status === 'requires_follow_up') summary.regularization_follow_up_total += 1;
    }

    return Array.from(byRep.values())
      .sort((a, b) => Number(b.total_visits || 0) - Number(a.total_visits || 0) || String(a.rep_name || '').localeCompare(String(b.rep_name || '')));
  }

  const visitAgg = db('visit_reports')
    .select(
      'rep_id',
      db.raw('count(DISTINCT id) AS total_visits'),
      db.raw('count(DISTINCT pharmacy_id) AS unique_pharmacies_visited'),
      db.raw(`count(*) FILTER (WHERE outcome = 'interested') AS interested_count`),
      db.raw(`count(*) FILTER (WHERE outcome = 'needs_follow_up') AS follow_up_count`),
      db.raw('min(created_at) AS first_visit'),
      db.raw('max(created_at) AS last_visit'),
    )
    .groupBy('rep_id')
    .as('va');

  const verificationAgg = db('pharmacy_verifications')
    .select(
      'rep_id',
      db.raw('count(*) AS assigned_total'),
      db.raw(`count(*) FILTER (WHERE assignment_status = 'completed') AS completed_total`),
      db.raw(`count(*) FILTER (WHERE photo_url IS NOT NULL) AS with_photo_total`),
      db.raw(`count(*) FILTER (WHERE comment IS NOT NULL AND btrim(comment) <> '') AS with_comment_total`),
      db.raw(`count(*) FILTER (WHERE regularization_status = 'requires_follow_up') AS regularization_follow_up_total`),
    )
    .groupBy('rep_id')
    .as('pva');

  const q = db('users as u')
    .leftJoin(visitAgg, 'va.rep_id', 'u.id')
    .leftJoin(verificationAgg, 'pva.rep_id', 'u.id')
    .select(
      'u.id as rep_id',
      'u.full_name as rep_name',
      db.raw('COALESCE(va.total_visits, 0) AS total_visits'),
      db.raw('COALESCE(va.unique_pharmacies_visited, 0) AS unique_pharmacies_visited'),
      db.raw('COALESCE(va.interested_count, 0) AS interested_count'),
      db.raw('COALESCE(va.follow_up_count, 0) AS follow_up_count'),
      db.raw('COALESCE(pva.assigned_total, 0) AS assigned_total'),
      db.raw('COALESCE(pva.completed_total, 0) AS completed_total'),
      db.raw('COALESCE(pva.with_photo_total, 0) AS with_photo_total'),
      db.raw('COALESCE(pva.with_comment_total, 0) AS with_comment_total'),
      db.raw('COALESCE(pva.regularization_follow_up_total, 0) AS regularization_follow_up_total'),
      'va.first_visit',
      'va.last_visit',
    )
    .where('u.role', 'field_rep')
    .where('u.is_active', true)
    .orderBy([{ column: 'total_visits', order: 'desc' }, { column: 'rep_name', order: 'asc' }]);

  const scope = getUserScope();
  if (scope && !scope.isGlobal && isScopeFilteringEnabled()) {
    const ids = scope.accessibleTerritoryIds || [];
    if (ids.length === 0) {
      q.whereRaw('1 = 0');
    } else {
      q.whereIn('u.id', function () {
        this.select('user_id')
          .from('user_territories')
          .whereIn('territory_id', ids)
          .whereNull('valid_to');
      });
    }
  }

  return q;
}

async function getCoverageByMunicipality() {
  if (isExternalDataMode()) {
    const { poiRows, currentRows } = await getExternalDashboardData();
    const currentByPharmacy = new Map(currentRows.map((row) => [String(row.pharmacy_id), row]));
    const grouped = new Map();

    for (const pharmacy of poiRows) {
      const key = pharmacy.municipality || 'Unknown';
      if (!grouped.has(key)) {
        grouped.set(key, {
          municipality: key,
          total_pharmacies: 0,
          assigned_total: 0,
          visited_total: 0,
        });
      }
      const group = grouped.get(key);
      const current = currentByPharmacy.get(String(pharmacy.id));
      group.total_pharmacies += 1;
      if (current && ['assigned', 'in_progress', 'reassigned', 'completed'].includes(current.assignment_status)) {
        group.assigned_total += 1;
      }
      if (current?.visited_at) group.visited_total += 1;
    }

    return Array.from(grouped.values()).map((row) => ({
      ...row,
      coverage_pct: row.total_pharmacies > 0 ? Number(((row.visited_total * 100) / row.total_pharmacies).toFixed(1)) : 0,
    }));
  }

  const scope = getUserScope();
  if (!scope || scope.isGlobal || !isScopeFilteringEnabled()) {
    return db('mv_coverage_by_municipality').select('*');
  }
  const ids = scope.accessibleTerritoryIds || [];
  if (ids.length === 0) return [];
  const rows = await db('pharmacies as p')
    .leftJoin('territories as t', 't.id', 'p.territory_id')
    .select(
      db.raw(`COALESCE(t.name, p.municipality, 'Unknown') AS municipality`),
      db.raw('count(*) AS total_pharmacies'),
      db.raw('count(*) FILTER (WHERE p.assigned_rep_id IS NOT NULL) AS assigned_total'),
      db.raw('count(*) FILTER (WHERE p.last_visited_at IS NOT NULL) AS visited_total'),
    )
    .where('p.is_independent', true)
    .whereIn('p.territory_id', ids)
    .groupByRaw(`COALESCE(t.name, p.municipality, 'Unknown')`);
  return rows.map((r) => ({
    ...r,
    coverage_pct: Number(r.total_pharmacies) > 0
      ? Number(((Number(r.visited_total) * 100) / Number(r.total_pharmacies)).toFixed(1))
      : 0,
  }));
}

async function getAssignmentProgress(filters = {}) {
  if (isExternalDataMode()) {
    const rows = await externalFieldSurveyRepository.listCurrentState({
      rep_id: filters.rep_id,
      assignment_status: filters.status,
      limit: 20000,
    });
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.assignment_id)) {
        grouped.set(row.assignment_id, {
          assignment_id: row.assignment_id,
          rep_id: row.rep_id,
          assignment_status: row.assignment_status,
          created_at: row.assigned_at || row.visited_at || new Date().toISOString(),
          total_stops: 0,
          completed_stops: 0,
        });
      }
      const group = grouped.get(row.assignment_id);
      group.total_stops += 1;
      if (row.assignment_status === 'completed') group.completed_stops += 1;
      if (row.assignment_status !== 'completed' && group.assignment_status === 'completed') {
        group.assignment_status = row.assignment_status;
      }
    }
    return Array.from(grouped.values()).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  const scope = getUserScope();
  if (!scope || scope.isGlobal || !isScopeFilteringEnabled()) {
    const q = db('mv_assignment_progress').select('*');
    if (filters.rep_id) q.where('rep_id', filters.rep_id);
    if (filters.status) q.where('assignment_status', filters.status);
    return q.orderBy('created_at', 'desc');
  }
  const ids = scope.accessibleTerritoryIds || [];
  if (ids.length === 0) return [];
  const q = db('territory_assignments as ta')
    .leftJoin('users as u', 'u.id', 'ta.rep_id')
    .select(
      'ta.id',
      'ta.rep_id',
      'u.full_name as rep_name',
      'ta.campaign_objective',
      'ta.status as assignment_status',
      'ta.created_at',
      db.raw(`(SELECT count(*) FROM assignment_stops WHERE assignment_id = ta.id) AS total_stops`),
      db.raw(`(SELECT count(*) FROM assignment_stops WHERE assignment_id = ta.id AND stop_status = 'completed') AS completed_stops`),
    )
    .where(function () {
      this.whereIn('ta.territory_id', ids).orWhereIn('ta.rep_id', function () {
        this.select('user_id')
          .from('user_territories')
          .whereIn('territory_id', ids)
          .whereNull('valid_to');
      });
    });
  if (filters.rep_id) q.where('ta.rep_id', filters.rep_id);
  if (filters.status) q.where('ta.status', filters.status);
  return q.orderBy('ta.created_at', 'desc');
}

async function getPotentialSales() {
  if (isExternalDataMode()) {
    const currentRows = await externalFieldSurveyRepository.listCurrentState({ limit: 20000 });
    const totalPotential = currentRows.reduce((sum, row) => sum + Number(row.order_potential || 0), 0);
    const interestedPotential = currentRows
      .filter((row) => row.visit_status === 'interested')
      .reduce((sum, row) => sum + Number(row.order_potential || 0), 0);
    return {
      total_potential_sales: totalPotential,
      interested_potential_sales: interestedPotential,
    };
  }

  const rows = await db('mv_potential_sales').select('*');
  return rows[0] || {};
}

async function getDashboard() {
  const [funnel, reps, coverage, sales] = await Promise.all([
    getPharmacyFunnel(),
    getRepProductivity(),
    getCoverageByMunicipality(),
    getPotentialSales(),
  ]);
  return { funnel, reps, coverage, sales };
}

async function exportPharmacies(filters = {}) {
  if (isExternalDataMode()) {
    const [pharmacies, currentRows, repNameMap] = await Promise.all([
      externalPoiRepository.list({ municipality: filters.municipality, status: filters.status, limit: 5000 }),
      externalFieldSurveyRepository.listCurrentState({ limit: 20000 }),
      getRepNameMap(),
    ]);
    const currentByPharmacy = new Map(currentRows.map((row) => [String(row.pharmacy_id), row]));
    return Promise.all(pharmacies.map(async (pharmacy) => {
      const evidence = currentByPharmacy.get(String(pharmacy.id)) || {};
      return {
        id: pharmacy.id,
        name: pharmacy.name,
        address: pharmacy.address,
        municipality: pharmacy.municipality,
        status: evidence.assignment_status || pharmacy.status,
        verification_status: evidence.regularization_status || pharmacy.verification_status,
        contact_phone: pharmacy.contact_phone,
        contact_person: pharmacy.contact_person,
        last_visit_outcome: evidence.visit_status || null,
        last_visited_at: evidence.visited_at || null,
        order_potential: evidence.order_potential || pharmacy.order_potential,
        notes: evidence.comment || null,
        source: 'external_poi',
        lng: pharmacy.lng,
        lat: pharmacy.lat,
        latest_photo_url: await resolveEvidenceAccessUrl(evidence.photo_url),
        latest_verification_comment: evidence.comment || null,
        latest_verification_status: evidence.visit_status || null,
        latest_regularization_status: evidence.regularization_status || null,
        latest_verification_rep_name: evidence.rep_name || repNameMap.get(String(evidence.rep_id)) || null,
        latest_verified_at: evidence.visited_at || null,
      };
    }));
  }

  const q = db('pharmacies')
    .select(
      'id',
      'name', 'address', 'municipality', 'status', 'verification_status',
      'contact_phone', 'contact_person', 'last_visit_outcome', 'last_visited_at',
      'order_potential', 'notes', 'source',
      db.raw(`ST_X(coordinates::geometry) AS lng`),
      db.raw(`ST_Y(coordinates::geometry) AS lat`),
    )
    .where({ is_independent: true });

  if (filters.municipality) q.where('municipality', filters.municipality);
  if (filters.status) q.where('status', filters.status);
  applyPharmacyScope(q, 'pharmacies.territory_id');
  q.orderBy('name');

  const pharmacies = await q;
  if (!pharmacies.length) return [];

  const latestEvidence = await db('pharmacy_verifications as pv')
    .distinctOn('pv.pharmacy_id')
    .leftJoin('users as u', 'u.id', 'pv.rep_id')
    .select(
      'pv.pharmacy_id',
      'pv.photo_url',
      'pv.comment',
      'pv.visit_status',
      'pv.regularization_status',
      'pv.visited_at',
      'u.full_name as verification_rep_name',
    )
    .whereIn('pv.pharmacy_id', pharmacies.map((row) => row.id))
    .orderBy(['pv.pharmacy_id', { column: 'pv.visited_at', order: 'desc' }, { column: 'pv.assigned_at', order: 'desc' }]);

  const evidenceByPharmacyId = new Map(latestEvidence.map((row) => [row.pharmacy_id, row]));
  return Promise.all(pharmacies.map(async (pharmacy) => {
    const evidence = evidenceByPharmacyId.get(pharmacy.id) || {};
    return {
      ...pharmacy,
      latest_photo_url: await resolveEvidenceAccessUrl(evidence.photo_url),
      latest_verification_comment: evidence.comment || null,
      latest_verification_status: evidence.visit_status || null,
      latest_regularization_status: evidence.regularization_status || null,
      latest_verification_rep_name: evidence.verification_rep_name || null,
      latest_verified_at: evidence.visited_at || null,
    };
  }));
}

async function getRepAssignmentsForExport() {
  if (!isExternalDataMode()) return [];

  const assignmentService = require('../assignments/assignments.service');
  const assignments = await assignmentService.list({});
  const reps = accessDirectory.listFieldRepsByScope(getDataScope());
  const repMap = new Map(reps.map((r) => [String(r.id), r]));
  const poiRows = await externalPoiRepository.list({ limit: 6000 });
  const poiById = new Map(poiRows.map((p) => [String(p.id), p]));

  return assignments
    .filter((a) => a.rep_id && a.status !== 'completed' && a.status !== 'cancelled')
    .map((a) => {
      const rep = repMap.get(String(a.rep_id));
      const stops = (a.stops || []).map((s) => {
        const poi = poiById.get(String(s.pharmacy_id));
        return {
          ...s,
          municipality: poi?.municipality || null,
        };
      });
      return {
        repId: a.rep_id,
        repName: rep?.full_name || a.rep_name || a.rep_id,
        repEmail: rep?.email || `${a.rep_id}@marzam.mx`,
        waveId: a.wave_id || null,
        campaignObjective: a.campaign_objective || null,
        stops,
      };
    });
}

async function getVisitDetail(filters = {}) {
  if (isExternalDataMode()) {
    const currentRows = await externalFieldSurveyRepository.listCurrentState({ limit: 20000 });
    const repNameMap = await getRepNameMap();
    let rows = currentRows.filter((r) => r.visited_at);

    if (filters.rep_id) rows = rows.filter((r) => r.rep_id === String(filters.rep_id));
    if (filters.from) rows = rows.filter((r) => r.visited_at >= filters.from);
    if (filters.to) rows = rows.filter((r) => r.visited_at <= filters.to);

    return rows.map((r) => ({
      pharmacy_id: r.pharmacy_id,
      rep_id: r.rep_id,
      rep_name: r.rep_name || repNameMap.get(String(r.rep_id)) || null,
      visit_status: r.visit_status,
      visited_at: r.visited_at,
      comment: r.comment,
      order_potential: r.order_potential,
      contact_name: r.contact_name,
      contact_phone: r.contact_phone,
      photo_url: r.photo_url,
      assignment_id: r.assignment_id,
      route_order: r.route_order,
    }));
  }

  const q = db('visit_reports as v')
    .join('users as u', 'u.id', 'v.rep_id')
    .join('pharmacies as p', 'p.id', 'v.pharmacy_id')
    .select(
      'v.id',
      'v.pharmacy_id',
      'p.name as pharmacy_name',
      'p.municipality',
      'v.rep_id',
      'u.full_name as rep_name',
      'v.outcome',
      'v.notes',
      'v.order_potential',
      'v.contact_person',
      'v.contact_phone',
      'v.contact_name',
      'v.contact_email',
      'v.wholesalers',
      'v.visit_observations',
      'v.competition_info',
      'v.competition_prices',
      'v.competition_offers',
      'v.checkin_lat',
      'v.checkin_lng',
      'v.created_at',
    )
    .orderBy('v.created_at', 'desc');

  if (filters.rep_id) q.where('v.rep_id', filters.rep_id);
  if (filters.from) q.where('v.created_at', '>=', filters.from);
  if (filters.to) q.where('v.created_at', '<=', filters.to);
  if (filters.pharmacy_id) q.where('v.pharmacy_id', filters.pharmacy_id);
  if (filters.outcome) {
    if (Array.isArray(filters.outcome)) q.whereIn('v.outcome', filters.outcome);
    else q.where('v.outcome', filters.outcome);
  }

  applyPharmacyScope(q, 'p.territory_id');

  const limit = Math.min(Number(filters.limit) || 200, 2000);
  q.limit(limit);

  return q;
}

async function getFlotillaSummary() {
  if (isExternalDataMode()) {
    const { currentRows, locationRows, repNameMap } = await getExternalDashboardData();
    const today = new Date().toISOString().slice(0, 10);
    const visitedToday = currentRows.filter((r) => r.visited_at && r.visited_at.slice(0, 10) === today);
    const skippedToday = currentRows.filter((r) => ['closed', 'invalid', 'duplicate', 'moved'].includes(r.visit_status) && r.visited_at?.slice(0, 10) === today);
    const activeReps = new Set(locationRows.filter((r) => {
      const age = Date.now() - new Date(r.recorded_at).getTime();
      return age < 3600000;
    }).map((r) => r.rep_id));

    return {
      visits_today: visitedToday.length,
      skipped_today: skippedToday.length,
      pending_total: currentRows.filter((r) => r.visit_status === 'pending').length,
      active_reps: activeReps.size,
      total_reps: repNameMap.size,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const [visits] = await db('visit_reports')
    .count('id as cnt')
    .where('created_at', '>=', today);
  const [skipped] = await db('visit_reports')
    .count('id as cnt')
    .where('created_at', '>=', today)
    .whereIn('outcome', ['closed', 'invalid', 'duplicate', 'moved', 'wrong_category', 'chain_not_independent']);
  const [pending] = await db('assignment_stops')
    .count('id as cnt')
    .where('stop_status', 'pending');
  const [activeReps] = await db('rep_tracking_points')
    .countDistinct('rep_id as cnt')
    .where('recorded_at', '>=', db.raw(`NOW() - INTERVAL '1 hour'`));
  const [totalReps] = await db('users')
    .count('id as cnt')
    .where({ role: 'field_rep', is_active: true });

  return {
    visits_today: Number(visits.cnt || 0),
    skipped_today: Number(skipped.cnt || 0),
    pending_total: Number(pending.cnt || 0),
    active_reps: Number(activeReps.cnt || 0),
    total_reps: Number(totalReps.cnt || 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Marzam Execution Doc §10 KPIs (locked set):
//   - Route adherence (planned vs completed)
//   - Visit duration (manual start/end)
//   - Prospect conversion funnel (visited → docs submitted → approved → onboarded)
//   - Sales vs target by role
//   - "Routes started on time" (Item 6 follow-up)
// All accept an optional `{ from, to }` window (ISO date strings).  Defaults:
// last 7 days for adherence/duration, last 30 days for funnel.
// ─────────────────────────────────────────────────────────────────────────

function defaultWindow({ from, to } = {}, daysBack = 7) {
  const tt = to ? new Date(to) : new Date();
  const ff = from ? new Date(from) : new Date(tt.getTime() - daysBack * 24 * 60 * 60 * 1000);
  return { from: ff.toISOString().slice(0, 10), to: tt.toISOString().slice(0, 10) };
}

async function getRouteAdherence({ from, to } = {}) {
  if (isExternalDataMode()) return { warning: 'external_mode', overall: null, by_user: [] };
  const w = defaultWindow({ from, to }, 7);
  // visit_plan_assignments status: planned/done/skipped/rescheduled.
  // Adherence = done / (planned + done + skipped) — excludes rescheduled (which is intentional change of plan, not skipped execution).
  const overallRow = await db.raw(`
    SELECT COUNT(*) FILTER (WHERE status = 'done')                          AS done,
           COUNT(*) FILTER (WHERE status IN ('planned','done','skipped'))    AS denom
      FROM visit_plan_assignments
     WHERE scheduled_date BETWEEN ?::date AND ?::date
  `, [w.from, w.to]);
  const denom = Number(overallRow.rows?.[0]?.denom || 0);
  const done = Number(overallRow.rows?.[0]?.done || 0);
  const overall = denom > 0 ? Number((done / denom).toFixed(4)) : null;

  const byUser = await db.raw(`
    SELECT vpa.visitor_user_id              AS user_id,
           u.full_name                       AS full_name,
           u.role                            AS role,
           COUNT(*) FILTER (WHERE status = 'done')                          AS done,
           COUNT(*) FILTER (WHERE status IN ('planned','done','skipped'))    AS denom
      FROM visit_plan_assignments vpa
      JOIN users u ON u.id = vpa.visitor_user_id
     WHERE vpa.scheduled_date BETWEEN ?::date AND ?::date
     GROUP BY vpa.visitor_user_id, u.full_name, u.role
     ORDER BY done DESC
  `, [w.from, w.to]);

  return {
    window: w,
    overall_adherence: overall,
    overall_done: done,
    overall_denom: denom,
    by_user: byUser.rows.map((r) => ({
      user_id: r.user_id,
      full_name: r.full_name,
      role: r.role,
      done: Number(r.done),
      denom: Number(r.denom),
      adherence: Number(r.denom) ? Number((Number(r.done) / Number(r.denom)).toFixed(4)) : null,
    })),
  };
}

async function getVisitDuration({ from, to } = {}) {
  if (isExternalDataMode()) return { warning: 'external_mode' };
  const w = defaultWindow({ from, to }, 7);
  // Visit duration is derived from visit_sessions when available (session has
  // started_at and ended_at). Falls back to NULL otherwise — the brief
  // explicitly mandates "manual start/end" so this is the expected source.
  const overallRow = await db.raw(`
    SELECT COUNT(*)::int                                                    AS sessions,
           AVG(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0)          AS avg_minutes,
           AVG(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0
               / NULLIF(pharmacies_visited, 0))                              AS avg_minutes_per_pharmacy
      FROM visit_sessions
     WHERE status = 'ended'
       AND started_at::date BETWEEN ?::date AND ?::date
       AND ended_at IS NOT NULL
  `, [w.from, w.to]);
  return {
    window: w,
    sessions: Number(overallRow.rows?.[0]?.sessions || 0),
    avg_minutes: overallRow.rows?.[0]?.avg_minutes != null ? Number(Number(overallRow.rows[0].avg_minutes).toFixed(2)) : null,
    avg_minutes_per_pharmacy: overallRow.rows?.[0]?.avg_minutes_per_pharmacy != null ? Number(Number(overallRow.rows[0].avg_minutes_per_pharmacy).toFixed(2)) : null,
  };
}

async function getProspectFunnel({ from, to } = {}) {
  if (isExternalDataMode()) return { warning: 'external_mode' };
  const w = defaultWindow({ from, to }, 30);
  // Stages per Marzam Execution Doc §10:
  //   1) visited      — at least one visit_report on the prospect pharmacy
  //   2) docs_submitted — pharmacy_onboarding row created (with docs)
  //   3) approved     — onboarding.status='aprobado'
  //   4) onboarded    — onboarding.status='pendiente_creacion_interna' OR linked to a marzam_clients
  // Defensive: pharmacy_onboarding may not exist (mig 038 not applied yet).
  const onboardingExists = await db.raw(`SELECT to_regclass('pharmacy_onboarding') AS t`);
  const visited = await db.raw(`
    SELECT COUNT(DISTINCT vr.pharmacy_id)::int AS n
      FROM visit_reports vr
      JOIN pharmacies p ON p.id = vr.pharmacy_id
     WHERE vr.created_at::date BETWEEN ?::date AND ?::date
       AND p.source <> 'marzam'
  `, [w.from, w.to]);

  let docsSubmitted = 0; let approved = 0; let onboarded = 0;
  if (onboardingExists.rows?.[0]?.t) {
    const o = await db.raw(`
      SELECT
        COUNT(*) FILTER (WHERE created_at::date BETWEEN ?::date AND ?::date)            AS docs,
        COUNT(*) FILTER (WHERE status = 'aprobado'  AND updated_at::date BETWEEN ?::date AND ?::date) AS approved,
        COUNT(*) FILTER (WHERE status = 'pendiente_creacion_interna' AND updated_at::date BETWEEN ?::date AND ?::date) AS onboarded
        FROM pharmacy_onboarding
    `, [w.from, w.to, w.from, w.to, w.from, w.to]);
    docsSubmitted = Number(o.rows?.[0]?.docs || 0);
    approved = Number(o.rows?.[0]?.approved || 0);
    onboarded = Number(o.rows?.[0]?.onboarded || 0);
  }
  return {
    window: w,
    stages: {
      visited: Number(visited.rows?.[0]?.n || 0),
      docs_submitted: docsSubmitted,
      approved,
      onboarded,
    },
    notes: onboardingExists.rows?.[0]?.t ? null : 'pharmacy_onboarding table missing — only "visited" stage available',
  };
}

async function getSalesVsTarget({ from, to } = {}) {
  if (isExternalDataMode()) return { warning: 'external_mode' };
  const w = defaultWindow({ from, to }, 30);
  // sales_targets has a per-cliente periodic objective; daily_sales is the
  // realized fact. We aggregate both at the (marzam_client_id) level then
  // compare. Result is keyed by client; FE rolls up to rep/sup/gerente.
  const exists = await db.raw(`
    SELECT to_regclass('daily_sales') AS s, to_regclass('sales_targets') AS t
  `);
  if (!exists.rows?.[0]?.s || !exists.rows?.[0]?.t) {
    return { window: w, warning: 'sales_or_targets_missing', items: [] };
  }
  const rows = await db.raw(`
    WITH realized AS (
      SELECT marzam_client_id, COALESCE(SUM(amount), 0) AS realized
        FROM daily_sales
       WHERE sale_date BETWEEN ?::date AND ?::date
       GROUP BY marzam_client_id
    ),
    target_by_client AS (
      SELECT mc.id AS marzam_client_id, COALESCE(SUM(st.objetivo), 0) AS target
        FROM marzam_clients mc
        LEFT JOIN sales_targets st ON st.cpadre = mc.cpadre
       GROUP BY mc.id
    )
    SELECT mc.id           AS marzam_client_id,
           mc.cpadre,
           mc.farmacia_nombre,
           mc.pareto,
           COALESCE(r.realized, 0)::numeric AS realized,
           COALESCE(t.target, 0)::numeric   AS target,
           CASE WHEN COALESCE(t.target, 0) > 0
                THEN COALESCE(r.realized, 0)::numeric / t.target::numeric
                ELSE NULL
           END                                AS attainment
      FROM marzam_clients mc
      LEFT JOIN realized r       ON r.marzam_client_id = mc.id
      LEFT JOIN target_by_client t ON t.marzam_client_id = mc.id
     WHERE COALESCE(r.realized, 0) > 0 OR COALESCE(t.target, 0) > 0
     ORDER BY COALESCE(r.realized, 0) DESC
     LIMIT 500
  `, [w.from, w.to]);
  return { window: w, items: rows.rows };
}

async function getRoutesStartedOnTime({ from, to } = {}) {
  if (isExternalDataMode()) return { warning: 'external_mode' };
  const w = defaultWindow({ from, to }, 7);
  // Compares actual_start_time vs expected_start_time +/- 15min grace.
  // Uses fields added in mig 053 (hard schedule). Defensive: if those columns
  // don't exist, returns warning.
  const colExists = await db.raw(`
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'visit_plan_assignments' AND column_name = 'actual_start_time'
     LIMIT 1
  `);
  if (!colExists.rows?.length) {
    return { window: w, warning: 'hard_schedule_columns_missing', overall: null };
  }
  const row = await db.raw(`
    SELECT
      COUNT(*)                                                                     AS denom,
      COUNT(*) FILTER (
        WHERE expected_start_time IS NOT NULL
          AND actual_start_time IS NOT NULL
          AND actual_start_time <= expected_start_time + INTERVAL '15 minutes'
      )                                                                             AS on_time,
      COUNT(*) FILTER (
        WHERE expected_start_time IS NOT NULL
          AND actual_start_time IS NULL
      )                                                                             AS not_started
      FROM visit_plan_assignments
     WHERE scheduled_date BETWEEN ?::date AND ?::date
       AND expected_start_time IS NOT NULL
  `, [w.from, w.to]);
  const denom = Number(row.rows?.[0]?.denom || 0);
  const onTime = Number(row.rows?.[0]?.on_time || 0);
  return {
    window: w,
    overall_pct: denom > 0 ? Number((onTime / denom).toFixed(4)) : null,
    on_time: onTime,
    not_started: Number(row.rows?.[0]?.not_started || 0),
    denom,
  };
}

module.exports = {
  refreshViews,
  getPharmacyFunnel,
  getRepProductivity,
  getCoverageByMunicipality,
  getAssignmentProgress,
  getPotentialSales,
  getDashboard,
  exportPharmacies,
  getRepAssignmentsForExport,
  getVisitDetail,
  getFlotillaSummary,
  // Marzam Execution Doc §10 KPI set:
  getRouteAdherence,
  getVisitDuration,
  getProspectFunnel,
  getSalesVsTarget,
  getRoutesStartedOnTime,
};
