const db = require('../../config/database');
const verificationService = require('../verifications/verifications.service');
const externalPoiRepository = require('../../repositories/external/poiRepository');
const externalDeviceLocationRepository = require('../../repositories/external/deviceLocationRepository');
const { isExternalDataMode } = require('../../repositories/runtime');
const { parseStopId } = require('../externalData/externalAssignmentIds');
const accessDirectory = require('../../services/accessDirectory');

const DISTANCE_WARNING_THRESHOLD_M = 500;

async function recordPing({ rep_id, assignment_id, verification_id, lat, lng, accuracy_meters }) {
  if (isExternalDataMode()) {
    const rep = accessDirectory.getUserById(rep_id);
    const event = {
      repId: rep_id,
      repName: rep?.full_name || 'Unknown Rep',
      assignmentId: assignment_id || null,
      verificationId: verification_id || null,
      lat,
      lng,
      accuracy: accuracy_meters || null,
      recordedAt: new Date().toISOString(),
    };
    await externalDeviceLocationRepository.insertLocation(event);
    return {
      rep_id,
      lat,
      lng,
      accuracy_meters: accuracy_meters || null,
      recorded_at: event.recordedAt,
    };
  }

  const rep = await db('users').select('full_name').where({ id: rep_id }).first();
  const [ping] = await db('rep_tracking_points')
    .insert({
      rep_id,
      rep_name_snapshot: rep?.full_name || 'Unknown Rep',
      verification_id: verification_id || null,
      assignment_id: assignment_id || null,
      lat,
      lng,
      accuracy_meters: accuracy_meters || null,
      point: db.raw(`ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography`, [lng, lat]),
    })
    .returning('*');
  return ping;
}

async function checkin({ rep_id, pharmacy_id, assignment_stop_id, lat, lng }) {
  const pharmacy = isExternalDataMode()
    ? await externalPoiRepository.getById(pharmacy_id)
    : await db('pharmacies')
      .select(db.raw(`ST_X(coordinates::geometry) AS lng, ST_Y(coordinates::geometry) AS lat`))
      .where({ id: pharmacy_id })
      .first();

  let distanceM = null;
  if (pharmacy) {
    const toRad = (value) => (value * Math.PI) / 180;
    const earthRadiusM = 6371000;
    const dLat = toRad(Number(pharmacy.lat) - Number(lat));
    const dLng = toRad(Number(pharmacy.lng) - Number(lng));
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(Number(lat))) * Math.cos(toRad(Number(pharmacy.lat))) * Math.sin(dLng / 2) ** 2;
    distanceM = 2 * earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  if (isExternalDataMode()) {
    await verificationService.syncCheckin({
      rep_id,
      pharmacy_id,
      assignment_stop_id,
      lat,
      lng,
      distance_to_pharmacy_m: distanceM,
    });

    return {
      rep_id,
      pharmacy_id,
      assignment_stop_id,
      lat,
      lng,
      distance_to_pharmacy_m: distanceM,
      checked_in_at: new Date().toISOString(),
      distance_warning: distanceM != null && distanceM > DISTANCE_WARNING_THRESHOLD_M,
    };
  }

  const [checkinRow] = await db('checkins')
    .insert({
      rep_id,
      pharmacy_id,
      assignment_stop_id: assignment_stop_id || null,
      lat,
      lng,
      distance_to_pharmacy_m: distanceM,
    })
    .returning('*');

  await verificationService.syncCheckin({
    rep_id,
    pharmacy_id,
    assignment_stop_id,
    lat,
    lng,
    distance_to_pharmacy_m: distanceM,
  });

  return {
    ...checkinRow,
    distance_warning: distanceM != null && distanceM > DISTANCE_WARNING_THRESHOLD_M,
  };
}

async function getCheckins(repId, filters = {}) {
  if (isExternalDataMode()) {
    const rows = await verificationService.listEvidence({ rep_id: repId, limit: filters.limit || 500 });
    let result = rows
      .filter((row) => row.checkin_lat != null && row.checkin_lng != null)
      .map((row) => ({
        rep_id: row.rep_id,
        pharmacy_id: row.pharmacy_id,
        pharmacy_name: row.pharmacy_name,
        pharmacy_lat: row.pharmacy_lat,
        pharmacy_lng: row.pharmacy_lng,
        assignment_stop_id: row.route_order ? `${row.assignment_id}::${row.route_order}::${row.pharmacy_id}` : null,
        lat: row.checkin_lat,
        lng: row.checkin_lng,
        checked_in_at: row.visited_at || row.assigned_at,
        distance_to_pharmacy_m: row.distance_to_pharmacy_m,
        distance_warning: row.distance_to_pharmacy_m != null && Number(row.distance_to_pharmacy_m) > DISTANCE_WARNING_THRESHOLD_M,
      }));

    if (filters.assignment_stop_id) {
      const parsed = parseStopId(filters.assignment_stop_id);
      result = result.filter((row) => row.assignment_stop_id === filters.assignment_stop_id
        || (parsed.assignment_id && row.assignment_stop_id?.startsWith(parsed.assignment_id)));
    }
    if (filters.from) result = result.filter((row) => row.checked_in_at >= filters.from);
    if (filters.to) result = result.filter((row) => row.checked_in_at <= filters.to);
    return result;
  }

  const q = db('checkins as c')
    .join('pharmacies as p', 'p.id', 'c.pharmacy_id')
    .select(
      'c.*',
      'p.name as pharmacy_name',
      db.raw(`ST_X(p.coordinates::geometry) AS pharmacy_lng`),
      db.raw(`ST_Y(p.coordinates::geometry) AS pharmacy_lat`),
      db.raw(`c.distance_to_pharmacy_m > ${DISTANCE_WARNING_THRESHOLD_M} AS distance_warning`),
    )
    .where({ 'c.rep_id': repId })
    .orderBy('c.checked_in_at', 'desc');

  if (filters.assignment_stop_id) q.where({ 'c.assignment_stop_id': filters.assignment_stop_id });
  if (filters.from) q.where('c.checked_in_at', '>=', filters.from);
  if (filters.to) q.where('c.checked_in_at', '<=', filters.to);
  if (filters.limit) q.limit(Number(filters.limit));

  return q;
}

async function getBreadcrumbs(repId, assignmentId, filters = {}) {
  if (isExternalDataMode()) {
    let rows = await externalDeviceLocationRepository.listLocations(10000);
    rows = rows.filter((row) => row.rep_id === String(repId));
    if (assignmentId && rows.some((row) => row.assignment_id)) {
      rows = rows.filter((row) => row.assignment_id === assignmentId);
    }
    if (filters.from) rows = rows.filter((row) => row.recorded_at >= filters.from);
    if (filters.to) rows = rows.filter((row) => row.recorded_at <= filters.to);
    rows.sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
    return rows.map((row) => ({
      lat: row.lat,
      lng: row.lng,
      recorded_at: row.recorded_at,
      accuracy_meters: row.accuracy_meters,
    }));
  }

  const q = db('rep_tracking_points')
    .select('lat', 'lng', 'recorded_at', 'accuracy_meters')
    .where({ rep_id: repId })
    .orderBy('recorded_at', 'asc')
    .limit(5000);

  if (assignmentId) q.where({ assignment_id: assignmentId });
  if (filters.from) q.where('recorded_at', '>=', filters.from);
  if (filters.to) q.where('recorded_at', '<=', filters.to);

  return q;
}

async function getLatestPositions() {
  if (isExternalDataMode()) {
    const rows = await externalDeviceLocationRepository.listLocations(10000);
    const latestByRep = new Map();
    for (const row of rows) {
      const existing = latestByRep.get(row.rep_id);
      if (!existing || new Date(row.recorded_at) > new Date(existing.recorded_at)) {
        latestByRep.set(row.rep_id, row);
      }
    }
    return Array.from(latestByRep.values()).map((row) => ({
      rep_id: row.rep_id,
      lat: row.lat,
      lng: row.lng,
      recorded_at: row.recorded_at,
      full_name: row.rep_name || null,
    }));
  }

  return db('rep_tracking_points as rtp')
    .distinctOn('rtp.rep_id')
    .select(
      'rtp.rep_id',
      'rtp.lat',
      'rtp.lng',
      'rtp.recorded_at',
      db.raw('rtp.rep_name_snapshot AS full_name'),
    )
    .orderBy(['rtp.rep_id', { column: 'rtp.recorded_at', order: 'desc' }]);
}

module.exports = { recordPing, checkin, getCheckins, getBreadcrumbs, getLatestPositions };
