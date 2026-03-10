const db = require('../../config/database');
const externalPoiRepository = require('../../repositories/external/poiRepository');
const externalFieldSurveyRepository = require('../../repositories/external/fieldSurveyRepository');
const { isExternalDataMode } = require('../../repositories/runtime');

function mergeOperationalFields(pharmacy, stateRow) {
  if (!stateRow) return pharmacy;
  return {
    ...pharmacy,
    assigned_rep_id: stateRow.rep_id || null,
    last_visit_outcome: stateRow.visit_status || null,
    last_visited_at: stateRow.visited_at || null,
    verification_status: stateRow.regularization_status || pharmacy.verification_status,
    latest_photo_url: stateRow.photo_url || null,
    latest_comment: stateRow.comment || null,
    latest_wave_id: stateRow.wave_id || null,
  };
}

async function listExternal(filters = {}) {
  const [pharmacies, currentState] = await Promise.all([
    externalPoiRepository.list({ ...filters, page: 1, limit: 5000 }),
    externalFieldSurveyRepository.listCurrentState({ limit: 20000 }),
  ]);
  const stateByPharmacyId = new Map(currentState.map((row) => [String(row.pharmacy_id), row]));
  let rows = pharmacies.map((pharmacy) => mergeOperationalFields(pharmacy, stateByPharmacyId.get(String(pharmacy.id))));

  if (filters.assigned_rep_id) rows = rows.filter((row) => row.assigned_rep_id === String(filters.assigned_rep_id));
  if (filters.verification_status) rows = rows.filter((row) => row.verification_status === filters.verification_status);
  if (filters.visit_outcome) rows = rows.filter((row) => row.last_visit_outcome === filters.visit_outcome);
  if (filters.last_visited_from) rows = rows.filter((row) => row.last_visited_at && row.last_visited_at >= filters.last_visited_from);
  if (filters.last_visited_to) rows = rows.filter((row) => row.last_visited_at && row.last_visited_at <= filters.last_visited_to);
  if (filters.potential_min) rows = rows.filter((row) => Number(row.order_potential || 0) >= Number(filters.potential_min));
  if (filters.potential_max) rows = rows.filter((row) => Number(row.order_potential || 0) <= Number(filters.potential_max));
  if (filters.has_contact === 'true') {
    rows = rows.filter((row) => row.contact_phone || row.contact_person);
  } else if (filters.has_contact === 'false') {
    rows = rows.filter((row) => !row.contact_phone && !row.contact_person);
  }
  if (filters.restrict_to_assigned && filters.rep_id) {
    rows = rows.filter((row) => row.assigned_rep_id === String(filters.rep_id));
  }

  const page = Number(filters.page) || 1;
  const limit = Math.min(Number(filters.limit) || 200, 5000);
  return rows.slice((page - 1) * limit, page * limit);
}

async function list(filters = {}) {
  if (isExternalDataMode()) {
    return listExternal(filters);
  }

  const q = db('pharmacies').select(
    'pharmacies.*',
    db.raw(`ST_X(coordinates::geometry) AS lng`),
    db.raw(`ST_Y(coordinates::geometry) AS lat`),
  );

  if (filters.municipality) q.where('municipality', filters.municipality);
  if (filters.status) q.where('status', filters.status);
  if (filters.assigned_rep_id) q.where('assigned_rep_id', filters.assigned_rep_id);
  if (filters.verification_status) q.where('verification_status', filters.verification_status);
  if (filters.visit_outcome) q.where('last_visit_outcome', filters.visit_outcome);

  if (filters.search) {
    q.where(function () {
      this.whereILike('name', `%${filters.search}%`)
        .orWhereILike('address', `%${filters.search}%`);
    });
  }

  if (filters.last_visited_from) q.where('last_visited_at', '>=', filters.last_visited_from);
  if (filters.last_visited_to) q.where('last_visited_at', '<=', filters.last_visited_to);
  if (filters.potential_min) q.where('order_potential', '>=', Number(filters.potential_min));
  if (filters.potential_max) q.where('order_potential', '<=', Number(filters.potential_max));
  if (filters.has_contact === 'true') {
    q.where(function () { this.whereNotNull('contact_phone').orWhereNotNull('contact_person'); });
  } else if (filters.has_contact === 'false') {
    q.whereNull('contact_phone').whereNull('contact_person');
  }

  if (filters.restrict_to_assigned && filters.rep_id) {
    q.whereIn('pharmacies.id', function () {
      this.select('as2.pharmacy_id')
        .from('assignment_stops as as2')
        .join('territory_assignments as ta2', 'ta2.id', 'as2.assignment_id')
        .where('ta2.rep_id', filters.rep_id)
        .whereIn('ta2.status', ['assigned', 'in_progress']);
    });
  }

  // Bounding-box spatial filter (for map viewport)
  if (filters.bbox) {
    const [west, south, east, north] = filters.bbox;
    q.whereRaw(
      `coordinates::geometry && ST_MakeEnvelope(?, ?, ?, ?, 4326)`,
      [west, south, east, north],
    );
  }

  // Pharmacies inside a GeoJSON polygon (for assignment preview)
  if (filters.polygon) {
    q.whereRaw(
      `ST_Within(coordinates::geometry, ST_SetSRID(ST_GeomFromGeoJSON(?), 4326))`,
      [JSON.stringify(filters.polygon)],
    );
  }

  const page = Number(filters.page) || 1;
  const limit = Math.min(Number(filters.limit) || 200, 5000);
  q.limit(limit).offset((page - 1) * limit);

  if (filters.sort_by) {
    q.orderBy(filters.sort_by, filters.sort_dir || 'asc');
  } else {
    q.orderBy('name', 'asc');
  }

  return q;
}

async function getById(id) {
  if (isExternalDataMode()) {
    const pharmacy = await externalPoiRepository.getById(id);
    const [stateRow] = await externalFieldSurveyRepository.listCurrentState({ pharmacy_id: id, limit: 100 });
    return mergeOperationalFields(pharmacy, stateRow);
  }

  const pharmacy = await db('pharmacies')
    .select('*', db.raw(`ST_X(coordinates::geometry) AS lng, ST_Y(coordinates::geometry) AS lat`))
    .where({ id })
    .first();
  if (!pharmacy) {
    const err = new Error('Pharmacy not found');
    err.status = 404;
    throw err;
  }
  return pharmacy;
}

async function update(id, data, _userId) {
  if (isExternalDataMode()) {
    const err = new Error('Direct pharmacy updates are not enabled in external data mode');
    err.status = 501;
    throw err;
  }

  const before = await getById(id);
  const [updated] = await db('pharmacies')
    .where({ id })
    .update({ ...data, updated_at: db.fn.now() })
    .returning('*');
  return { before, after: updated };
}

async function createCandidate(data) {
  if (isExternalDataMode()) {
    const err = new Error('New candidate pharmacies are not enabled in external data mode');
    err.status = 501;
    throw err;
  }

  return db.transaction(async (trx) => {
    const [pharmacy] = await trx('pharmacies')
      .insert({
        name: data.name,
        address: data.address,
        coordinates: trx.raw(
          `ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography`,
          [data.lng, data.lat],
        ),
        municipality: data.municipality || null,
        contact_phone: data.contact_phone || null,
        contact_person: data.contact_person || null,
        is_independent: data.is_independent ?? true,
        notes: data.notes || null,
        status: 'pending_review',
        verification_status: 'unverified',
        source: 'field_rep',
        created_by: data.created_by,
      })
      .returning('*');

    await trx('review_queue_items').insert({
      pharmacy_id: pharmacy.id,
      flag_type: 'new_pharmacy',
      reason: data.notes || 'New pharmacy discovered in field',
      submitted_by: data.created_by,
      queue_status: 'pending',
    });

    return pharmacy;
  });
}

async function findInsidePolygon(polygonGeoJSON) {
  if (isExternalDataMode()) {
    return externalPoiRepository.list({ polygon: polygonGeoJSON, limit: 5000 });
  }

  return db('pharmacies')
    .select('id', 'name', 'address', db.raw(`ST_X(coordinates::geometry) AS lng, ST_Y(coordinates::geometry) AS lat`))
    .whereRaw(
      `ST_Within(coordinates::geometry, ST_SetSRID(ST_GeomFromGeoJSON(?), 4326))`,
      [JSON.stringify(polygonGeoJSON)],
    );
}

async function isAssignedToRep(pharmacyId, repId) {
  if (isExternalDataMode()) {
    const [row] = await externalFieldSurveyRepository.listCurrentState({ pharmacy_id: pharmacyId, rep_id: repId, limit: 100 });
    return !!row && ['assigned', 'in_progress', 'reassigned', 'completed'].includes(row.assignment_status);
  }

  const row = await db('assignment_stops as s')
    .join('territory_assignments as ta', 'ta.id', 's.assignment_id')
    .where('s.pharmacy_id', pharmacyId)
    .where('ta.rep_id', repId)
    .whereIn('ta.status', ['assigned', 'in_progress'])
    .first();
  return !!row;
}

module.exports = { list, getById, update, createCandidate, findInsidePolygon, isAssignedToRep };
