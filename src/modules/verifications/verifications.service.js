const db = require('../../config/database');
const externalFieldSurveyRepository = require('../../repositories/external/fieldSurveyRepository');
const externalPoiRepository = require('../../repositories/external/poiRepository');
const { isExternalDataMode } = require('../../repositories/runtime');
const { buildAssignmentId, parseStopId } = require('../externalData/externalAssignmentIds');
const { resolveEvidenceAccessUrl } = require('../../utils/gcsEvidence');
const accessDirectory = require('../../services/accessDirectory');

const OUTCOME_TO_VISIT_STATUS = {
  visited: 'visited',
  contact_made: 'contact_made',
  interested: 'interested',
  not_interested: 'not_interested',
  needs_follow_up: 'follow_up_required',
  closed: 'closed',
  invalid: 'invalid',
  duplicate: 'duplicate',
  moved: 'moved',
  wrong_category: 'wrong_category',
  chain_not_independent: 'chain_not_independent',
};

function deriveVisitStatus(outcome) {
  return OUTCOME_TO_VISIT_STATUS[outcome] || 'visited';
}

function deriveRegularizationStatus(outcome) {
  if (outcome === 'needs_follow_up') return 'requires_follow_up';
  if (['closed', 'invalid', 'duplicate', 'moved', 'wrong_category', 'chain_not_independent'].includes(outcome)) {
    return 'rejected';
  }
  return 'verified';
}

async function getRepNameMap(repIds) {
  if (!repIds.length) return new Map();
  if (isExternalDataMode()) {
    return new Map(repIds
      .map((id) => accessDirectory.getUserById(id))
      .filter(Boolean)
      .map((user) => [String(user.id), user.full_name]));
  }
  const reps = await db('users').select('id', 'full_name').whereIn('id', repIds);
  return new Map(reps.map((row) => [String(row.id), row.full_name]));
}

async function decoratePhotoAccess(rows) {
  return Promise.all(rows.map(async (row) => ({
    ...row,
    photo_url: await resolveEvidenceAccessUrl(row.photo_url),
  })));
}

async function createForAssignmentExternal({ assignment, stops, wave_id = null }) {
  if (!assignment.rep_id || !stops.length) return [];
  const repNameMap = await getRepNameMap([assignment.rep_id]);
  const events = stops.map((stop) => ({
    assignmentId: assignment.id || buildAssignmentId({ wave_id: wave_id || assignment.wave_id, rep_id: assignment.rep_id }),
    pharmacyId: stop.pharmacy_id,
    repId: assignment.rep_id,
    repName: repNameMap.get(String(assignment.rep_id)) || null,
    waveId: wave_id || assignment.wave_id || 'default-wave',
    campaignObjective: assignment.campaign_objective || null,
    assignmentStatus: 'assigned',
    visitStatus: 'pending',
    regularizationStatus: 'pending',
    priority: assignment.priority || 'normal',
    routeOrder: stop.route_order || null,
    assignedAt: new Date().toISOString(),
    dueAt: assignment.due_date || null,
    createdBy: assignment.created_by || null,
  }));
  return externalFieldSurveyRepository.insertEvents(events);
}

async function syncAssignmentReassignmentExternal({ assignmentId, rep_id, priority, due_date }) {
  const currentRows = await externalFieldSurveyRepository.listCurrentState({ assignment_id: assignmentId, limit: 5000 });
  const repNameMap = await getRepNameMap(rep_id ? [rep_id] : []);
  const events = currentRows.map((row) => ({
    assignmentId,
    pharmacyId: row.pharmacy_id,
    repId: rep_id || row.rep_id,
    repName: repNameMap.get(String(rep_id)) || row.rep_name || null,
    waveId: row.wave_id,
    campaignObjective: row.campaign_objective || null,
    assignmentStatus: rep_id ? 'reassigned' : 'cancelled',
    visitStatus: row.visit_status,
    regularizationStatus: row.regularization_status,
    priority: priority || row.priority || 'normal',
    routeOrder: row.route_order,
    assignedAt: row.assigned_at || new Date().toISOString(),
    dueAt: due_date !== undefined ? due_date : row.due_at,
    visitedAt: row.visited_at,
    photoUrl: row.photo_url,
    comment: row.comment,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    orderPotential: row.order_potential,
  }));
  return externalFieldSurveyRepository.insertEvents(events);
}

async function syncVisitSubmissionExternal({ payload }) {
  const parsedStop = payload.assignment_stop_id ? parseStopId(payload.assignment_stop_id) : {};
  const [currentRow] = await externalFieldSurveyRepository.listCurrentState({
    pharmacy_id: payload.pharmacy_id,
    rep_id: payload.rep_id,
    assignment_id: parsedStop.assignment_id,
    limit: 100,
  });
  const repNameMap = await getRepNameMap([payload.rep_id]);
  const event = {
    assignmentId: parsedStop.assignment_id || currentRow?.assignment_id || buildAssignmentId({
      wave_id: currentRow?.wave_id,
      rep_id: payload.rep_id,
    }),
    pharmacyId: payload.pharmacy_id,
    repId: payload.rep_id,
    repName: repNameMap.get(String(payload.rep_id)) || currentRow?.rep_name || null,
    waveId: currentRow?.wave_id || 'default-wave',
    campaignObjective: currentRow?.campaign_objective || null,
    assignmentStatus: 'completed',
    visitStatus: deriveVisitStatus(payload.outcome),
    regularizationStatus: deriveRegularizationStatus(payload.outcome),
    priority: currentRow?.priority || 'normal',
    routeOrder: parsedStop.route_order || currentRow?.route_order || null,
    assignedAt: currentRow?.assigned_at || new Date().toISOString(),
    dueAt: currentRow?.due_at || null,
    visitedAt: new Date().toISOString(),
    checkinLat: payload.checkin_lat || null,
    checkinLng: payload.checkin_lng || null,
    comment: payload.notes || null,
    contactName: payload.contact_person || null,
    contactPhone: payload.contact_phone || null,
    orderPotential: payload.order_potential || null,
  };
  await externalFieldSurveyRepository.insertEvents([event]);
  return { verification: event };
}

async function syncCheckinExternal({ rep_id, pharmacy_id, assignment_stop_id, lat, lng, distance_to_pharmacy_m }) {
  const parsedStop = assignment_stop_id ? parseStopId(assignment_stop_id) : {};
  const [currentRow] = await externalFieldSurveyRepository.listCurrentState({
    pharmacy_id,
    rep_id,
    assignment_id: parsedStop.assignment_id,
    limit: 100,
  });
  const repNameMap = await getRepNameMap([rep_id]);
  const event = {
    assignmentId: parsedStop.assignment_id || currentRow?.assignment_id || buildAssignmentId({ wave_id: currentRow?.wave_id, rep_id }),
    pharmacyId: pharmacy_id,
    repId: rep_id,
    repName: repNameMap.get(String(rep_id)) || currentRow?.rep_name || null,
    waveId: currentRow?.wave_id || 'default-wave',
    campaignObjective: currentRow?.campaign_objective || null,
    assignmentStatus: currentRow?.assignment_status === 'completed' ? 'completed' : 'in_progress',
    visitStatus: currentRow?.visit_status || 'pending',
    regularizationStatus: currentRow?.regularization_status || 'pending',
    priority: currentRow?.priority || 'normal',
    routeOrder: parsedStop.route_order || currentRow?.route_order || null,
    assignedAt: currentRow?.assigned_at || new Date().toISOString(),
    dueAt: currentRow?.due_at || null,
    checkinLat: lat,
    checkinLng: lng,
    distanceMeters: distance_to_pharmacy_m,
    comment: currentRow?.comment || null,
    photoUrl: currentRow?.photo_url || null,
  };
  await externalFieldSurveyRepository.insertEvents([event]);
  return {
    ...event,
    distance_to_pharmacy_m,
  };
}

async function attachPhotoToVisitExternal({ visit, photoUrl, mimeType, sizeBytes }) {
  const [currentRow] = await externalFieldSurveyRepository.listCurrentState({
    pharmacy_id: visit.pharmacy_id,
    rep_id: visit.rep_id,
    assignment_id: visit.assignment_id,
    limit: 100,
  });

  const event = {
    assignmentId: visit.assignment_id || currentRow?.assignment_id,
    pharmacyId: visit.pharmacy_id,
    repId: visit.rep_id,
    repName: currentRow?.rep_name || null,
    waveId: visit.wave_id || currentRow?.wave_id || 'default-wave',
    campaignObjective: currentRow?.campaign_objective || null,
    assignmentStatus: currentRow?.assignment_status || 'completed',
    visitStatus: currentRow?.visit_status || 'visited',
    regularizationStatus: currentRow?.regularization_status || 'verified',
    priority: currentRow?.priority || 'normal',
    routeOrder: currentRow?.route_order || null,
    assignedAt: currentRow?.assigned_at || new Date().toISOString(),
    dueAt: currentRow?.due_at || null,
    visitedAt: visit.visited_at || currentRow?.visited_at || new Date().toISOString(),
    checkinLat: visit.checkin_lat || currentRow?.checkin_lat || null,
    checkinLng: visit.checkin_lng || currentRow?.checkin_lng || null,
    distanceMeters: currentRow?.distance_to_pharmacy_m || null,
    photoUrl,
    comment: currentRow?.comment || visit.notes || null,
    contactName: currentRow?.contact_name || visit.contact_person || null,
    contactPhone: currentRow?.contact_phone || visit.contact_phone || null,
    orderPotential: currentRow?.order_potential || visit.order_potential || null,
  };
  await externalFieldSurveyRepository.insertEvents([event]);

  return {
    ...event,
    photo_url: await resolveEvidenceAccessUrl(photoUrl),
    photo_mime_type: mimeType,
    photo_size_bytes: sizeBytes,
  };
}

async function listByPharmacyExternal(pharmacyId) {
  const repNameMap = await getRepNameMap((await externalFieldSurveyRepository.listHistory({ pharmacy_id: pharmacyId, limit: 5000 }))
    .map((row) => row.rep_id)
    .filter(Boolean));
  const rows = (await externalFieldSurveyRepository.listHistory({ pharmacy_id: pharmacyId, limit: 5000 }))
    .map((row) => ({
      ...row,
      rep_name: row.rep_name || repNameMap.get(String(row.rep_id)) || null,
    }));
  return decoratePhotoAccess(rows);
}

async function listEvidenceExternal(filters = {}) {
  const [poiRows, surveyRows] = await Promise.all([
    externalPoiRepository.list({ limit: 5000 }),
    externalFieldSurveyRepository.listHistory(filters),
  ]);
  const poiById = new Map(poiRows.map((row) => [String(row.id), row]));
  const repNameMap = await getRepNameMap(surveyRows.map((row) => row.rep_id).filter(Boolean));

  let rows = surveyRows
    .map((row) => {
      const poi = poiById.get(String(row.pharmacy_id));
      if (!poi) return null;
      return {
        ...row,
        pharmacy_id: poi.id,
        pharmacy_name: poi.name,
        pharmacy_address: poi.address,
        municipality: poi.municipality,
        state: poi.state,
        pharmacy_lat: poi.lat,
        pharmacy_lng: poi.lng,
        rep_name: row.rep_name || repNameMap.get(String(row.rep_id)) || null,
      };
    })
    .filter(Boolean);

  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    rows = rows.filter((row) =>
      String(row.pharmacy_name || '').toLowerCase().includes(q)
      || String(row.pharmacy_address || '').toLowerCase().includes(q)
      || String(row.rep_name || '').toLowerCase().includes(q)
      || String(row.comment || '').toLowerCase().includes(q));
  }

  rows.sort((a, b) =>
    new Date(b.updated_at || b.created_at || b.visited_at || b.assigned_at || 0).getTime()
    - new Date(a.updated_at || a.created_at || a.visited_at || a.assigned_at || 0).getTime());
  return decoratePhotoAccess(rows.slice(0, Math.min(Number(filters.limit) || rows.length, 500)));
}

async function getRepSummaryExternal(repId) {
  const rep = accessDirectory.getUserById(repId);
  const currentRows = await externalFieldSurveyRepository.listCurrentState({ rep_id: repId, limit: 5000 });
  const recentEvidence = await listEvidenceExternal({ rep_id: repId, limit: 3 });
  return {
    rep_id: repId,
    rep_name: rep?.full_name || null,
    assigned_total: currentRows.length,
    completed_total: currentRows.filter((row) => row.assignment_status === 'completed').length,
    with_photo_total: currentRows.filter((row) => !!row.photo_url).length,
    with_comment_total: currentRows.filter((row) => !!String(row.comment || '').trim()).length,
    follow_up_total: currentRows.filter((row) => row.regularization_status === 'requires_follow_up').length,
    last_verified_at: currentRows.reduce((latest, row) => {
      const value = row.visited_at || null;
      return !latest || (value && new Date(value) > new Date(latest)) ? value : latest;
    }, null),
    recent_evidence: recentEvidence,
  };
}

async function getVerificationByStopOrLatest({ trx = db, assignment_stop_id, pharmacy_id, rep_id }) {
  if (assignment_stop_id) {
    const byStop = await trx('pharmacy_verifications')
      .where({ assignment_stop_id })
      .first();
    if (byStop) return byStop;
  }

  if (pharmacy_id && rep_id) {
    return trx('pharmacy_verifications')
      .where({ pharmacy_id, rep_id })
      .orderBy('assigned_at', 'desc')
      .first();
  }

  return null;
}

async function createForAssignment({ trx = db, assignment, stops, wave_id = null }) {
  if (isExternalDataMode()) {
    return createForAssignmentExternal({ assignment, stops, wave_id });
  }

  if (!assignment.rep_id || !stops.length) return [];

  const pharmacyRows = await trx('pharmacies')
    .select('id', 'municipality', 'state')
    .whereIn('id', stops.map((stop) => stop.pharmacy_id));
  const pharmacyById = new Map(pharmacyRows.map((row) => [row.id, row]));

  const rows = stops.map((stop) => {
    const pharmacy = pharmacyById.get(stop.pharmacy_id) || {};
    return {
      pharmacy_id: stop.pharmacy_id,
      rep_id: assignment.rep_id,
      assignment_id: assignment.id,
      assignment_stop_id: stop.id,
      wave_id: wave_id || null,
      route_order: stop.route_order,
      assignment_status: 'assigned',
      visit_status: 'pending',
      regularization_status: 'pending',
      priority: assignment.priority || 'normal',
      assigned_at: trx.fn.now(),
      due_at: assignment.due_date || null,
      created_at: trx.fn.now(),
      updated_at: trx.fn.now(),
      municipality_snapshot: pharmacy.municipality || null,
      state_snapshot: pharmacy.state || null,
    };
  });

  return trx('pharmacy_verifications').insert(rows).returning('*');
}

async function syncAssignmentReassignment({ trx = db, assignmentId, rep_id, priority, due_date }) {
  if (isExternalDataMode()) {
    return syncAssignmentReassignmentExternal({ assignmentId, rep_id, priority, due_date });
  }

  const updates = {
    updated_at: trx.fn.now(),
  };

  if (rep_id !== undefined) {
    if (rep_id) updates.rep_id = rep_id;
    updates.assignment_status = rep_id ? 'reassigned' : 'cancelled';
  }
  if (priority) updates.priority = priority;
  if (due_date !== undefined) updates.due_at = due_date || null;

  return trx('pharmacy_verifications')
    .where({ assignment_id: assignmentId })
    .update(updates)
    .returning('*');
}

async function syncVisitSubmission({ trx = db, visit, payload }) {
  if (isExternalDataMode()) {
    return syncVisitSubmissionExternal({ payload });
  }

  let verification = await getVerificationByStopOrLatest({
    trx,
    assignment_stop_id: payload.assignment_stop_id,
    pharmacy_id: payload.pharmacy_id,
    rep_id: payload.rep_id,
  });

  if (!verification) {
    const [created] = await trx('pharmacy_verifications')
      .insert({
        pharmacy_id: payload.pharmacy_id,
        rep_id: payload.rep_id,
        assignment_id: null,
        assignment_stop_id: payload.assignment_stop_id || null,
        assignment_status: 'completed',
        visit_status: deriveVisitStatus(payload.outcome),
        regularization_status: deriveRegularizationStatus(payload.outcome),
        priority: 'normal',
        assigned_at: trx.fn.now(),
        visited_at: trx.fn.now(),
        checkin_lat: payload.checkin_lat || null,
        checkin_lng: payload.checkin_lng || null,
        comment: payload.notes || null,
        contact_name: payload.contact_person || null,
        contact_phone: payload.contact_phone || null,
        latest_outcome: payload.outcome,
        order_potential: payload.order_potential || null,
        created_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      })
      .returning('*');
    verification = created;
  } else {
    const [updated] = await trx('pharmacy_verifications')
      .where({ id: verification.id })
      .update({
        assignment_status: 'completed',
        visit_status: deriveVisitStatus(payload.outcome),
        regularization_status: deriveRegularizationStatus(payload.outcome),
        visited_at: trx.fn.now(),
        checkin_lat: payload.checkin_lat || verification.checkin_lat || null,
        checkin_lng: payload.checkin_lng || verification.checkin_lng || null,
        comment: payload.notes || null,
        contact_name: payload.contact_person || null,
        contact_phone: payload.contact_phone || null,
        latest_outcome: payload.outcome,
        order_potential: payload.order_potential || null,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    verification = updated;
  }

  return {
    visit,
    verification,
  };
}

async function syncCheckin({ trx = db, rep_id, pharmacy_id, assignment_stop_id, lat, lng, distance_to_pharmacy_m }) {
  if (isExternalDataMode()) {
    return syncCheckinExternal({ rep_id, pharmacy_id, assignment_stop_id, lat, lng, distance_to_pharmacy_m });
  }

  const verification = await getVerificationByStopOrLatest({
    trx,
    assignment_stop_id,
    pharmacy_id,
    rep_id,
  });

  if (!verification) return null;

  const [updated] = await trx('pharmacy_verifications')
    .where({ id: verification.id })
    .update({
      assignment_status: verification.assignment_status === 'completed' ? 'completed' : 'in_progress',
      started_at: verification.started_at || trx.fn.now(),
      checkin_lat: lat,
      checkin_lng: lng,
      distance_to_pharmacy_m,
      updated_at: trx.fn.now(),
    })
    .returning('*');

  return updated;
}

async function attachPhotoToVisit({ trx = db, visitId, photoUrl, bucket, objectPath, mimeType, sizeBytes }) {
  if (isExternalDataMode()) {
    return attachPhotoToVisitExternal({
      visit: visitId,
      photoUrl,
      bucket,
      objectPath,
      mimeType,
      sizeBytes,
    });
  }

  const visit = await trx('visit_reports').where({ id: visitId }).first();
  if (!visit) {
    const err = new Error('Visit not found');
    err.status = 404;
    throw err;
  }

  const verification = await getVerificationByStopOrLatest({
    trx,
    assignment_stop_id: visit.assignment_stop_id,
    pharmacy_id: visit.pharmacy_id,
    rep_id: visit.rep_id,
  });

  if (!verification) return null;

  const [updated] = await trx('pharmacy_verifications')
    .where({ id: verification.id })
    .update({
      photo_url: photoUrl,
      gcs_bucket: bucket,
      gcs_object_path: objectPath,
      photo_mime_type: mimeType,
      photo_size_bytes: sizeBytes,
      photo_uploaded_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    })
    .returning('*');

  return updated;
}

async function listByPharmacy(pharmacyId) {
  if (isExternalDataMode()) {
    return listByPharmacyExternal(pharmacyId);
  }

  const rows = await db('pharmacy_verifications as pv')
    .leftJoin('users as u', 'u.id', 'pv.rep_id')
    .select(
      'pv.*',
      'u.full_name as rep_name',
    )
    .where('pv.pharmacy_id', pharmacyId)
    .orderBy('pv.assigned_at', 'desc');
  return decoratePhotoAccess(rows);
}

async function listEvidence(filters = {}) {
  if (isExternalDataMode()) {
    return listEvidenceExternal(filters);
  }

  const q = db('pharmacy_verifications as pv')
    .join('pharmacies as p', 'p.id', 'pv.pharmacy_id')
    .join('users as u', 'u.id', 'pv.rep_id')
    .select(
      'pv.id',
      'pv.assignment_id',
      'pv.wave_id',
      'pv.assignment_status',
      'pv.visit_status',
      'pv.regularization_status',
      'pv.priority',
      'pv.assigned_at',
      'pv.due_at',
      'pv.visited_at',
      'pv.checkin_lat',
      'pv.checkin_lng',
      'pv.distance_to_pharmacy_m',
      'pv.photo_url',
      'pv.comment',
      'pv.contact_name',
      'pv.contact_phone',
      'pv.latest_outcome',
      'pv.order_potential',
      'p.id as pharmacy_id',
      'p.name as pharmacy_name',
      'p.address as pharmacy_address',
      'p.municipality',
      'p.state',
      db.raw('ST_X(p.coordinates::geometry) AS pharmacy_lng'),
      db.raw('ST_Y(p.coordinates::geometry) AS pharmacy_lat'),
      'u.id as rep_id',
      'u.full_name as rep_name',
    )
    .orderByRaw('COALESCE(pv.visited_at, pv.assigned_at) DESC');

  if (filters.rep_id) q.where('pv.rep_id', filters.rep_id);
  if (filters.assignment_id) q.where('pv.assignment_id', filters.assignment_id);
  if (filters.pharmacy_id) q.where('pv.pharmacy_id', filters.pharmacy_id);
  if (filters.visit_status) q.where('pv.visit_status', filters.visit_status);
  if (filters.assignment_status) q.where('pv.assignment_status', filters.assignment_status);
  if (filters.has_photo === 'true') q.whereNotNull('pv.photo_url');
  if (filters.has_photo === 'false') q.whereNull('pv.photo_url');
  if (filters.has_comment === 'true') q.whereNotNull('pv.comment');
  if (filters.has_comment === 'false') q.whereNull('pv.comment');
  if (filters.q) {
    q.where(function () {
      this.whereILike('p.name', `%${filters.q}%`)
        .orWhereILike('p.address', `%${filters.q}%`)
        .orWhereILike('u.full_name', `%${filters.q}%`)
        .orWhereILike('pv.comment', `%${filters.q}%`);
    });
  }
  q.limit(Math.min(Number(filters.limit) || 100, 500));

  const rows = await q;
  return decoratePhotoAccess(rows);
}

async function getRepSummary(repId) {
  if (isExternalDataMode()) {
    return getRepSummaryExternal(repId);
  }

  const rep = await db('users').select('full_name').where({ id: repId }).first();
  const [summary] = await db('pharmacy_verifications')
    .select(
      'rep_id',
      db.raw(`count(*) AS assigned_total`),
      db.raw(`count(*) FILTER (WHERE assignment_status = 'completed') AS completed_total`),
      db.raw(`count(*) FILTER (WHERE photo_url IS NOT NULL) AS with_photo_total`),
      db.raw(`count(*) FILTER (WHERE comment IS NOT NULL AND btrim(comment) <> '') AS with_comment_total`),
      db.raw(`count(*) FILTER (WHERE regularization_status = 'requires_follow_up') AS follow_up_total`),
      db.raw(`max(visited_at) AS last_verified_at`),
    )
    .where({ rep_id: repId })
    .groupBy('rep_id');

  const recentEvidence = await listEvidence({ rep_id: repId, limit: 3 });

  return {
    ...(summary || {
      rep_id: repId,
      assigned_total: 0,
      completed_total: 0,
      with_photo_total: 0,
      with_comment_total: 0,
      follow_up_total: 0,
      last_verified_at: null,
    }),
    rep_name: rep?.full_name || null,
    recent_evidence: recentEvidence,
  };
}

module.exports = {
  createForAssignment,
  syncAssignmentReassignment,
  syncVisitSubmission,
  syncCheckin,
  attachPhotoToVisit,
  listByPharmacy,
  listEvidence,
  getRepSummary,
};
