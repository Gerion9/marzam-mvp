const db = require('../../config/database');
const externalPoiRepository = require('../../repositories/external/poiRepository');
const externalFieldSurveyRepository = require('../../repositories/external/fieldSurveyRepository');
const externalDeviceLocationRepository = require('../../repositories/external/deviceLocationRepository');
const { isExternalDataMode } = require('../../repositories/runtime');
const { resolveEvidenceAccessUrl } = require('../../utils/gcsEvidence');
const accessDirectory = require('../../services/accessDirectory');
const { getDataScope } = require('../../middleware/requestContext');

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

  const rows = await db('pharmacies')
    .select(
      db.raw(`count(*) FILTER (WHERE is_independent = true) AS total_pharmacies`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND assigned_rep_id IS NOT NULL) AS assigned`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND last_visited_at IS NOT NULL) AS visited`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND last_visit_outcome = 'interested') AS interested`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND last_visit_outcome = 'needs_follow_up') AS needs_follow_up`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND status IN ('closed','invalid','duplicate','moved')) AS invalid_closed`),
      db.raw(`count(*) FILTER (WHERE is_independent = true AND last_visit_outcome = 'contact_made') AS contact_made`),
    );
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

  return db('users as u')
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

  return db('mv_coverage_by_municipality').select('*');
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

  const q = db('mv_assignment_progress').select('*');
  if (filters.rep_id) q.where('rep_id', filters.rep_id);
  if (filters.status) q.where('assignment_status', filters.status);
  return q.orderBy('created_at', 'desc');
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
};
