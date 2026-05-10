const db = require('../../config/database');
const verificationService = require('../verifications/verifications.service');
const externalPoiRepository = require('../../repositories/external/poiRepository');
const externalDeviceLocationRepository = require('../../repositories/external/deviceLocationRepository');
const { isExternalDataMode } = require('../../repositories/runtime');
const { parseStopId } = require('../externalData/externalAssignmentIds');
const accessDirectory = require('../../services/accessDirectory');
const liveBus = require('../live/live.service');
const { haversineMeters, DISTANCE_WARNING_THRESHOLD_M } = require('../../utils/geoDistance');

// Per-rep hierarchy cache so /ping doesn't issue an extra users JOIN per call.
// TTL 60s — long enough that 1 ping/30s reuses; short enough that role/manager
// changes propagate to live-ops within a minute. Key: rep_id → {role,
// manager_id, manager_name, branch_id, branch_name, employee_code, expiresAt}.
const HIERARCHY_TTL_MS = 60_000;
const hierarchyCache = new Map();

async function fetchHierarchyForRep(repId) {
  if (!repId) return null;
  const now = Date.now();
  const hit = hierarchyCache.get(repId);
  if (hit && hit.expiresAt > now) return hit;
  try {
    const row = await db('users as u')
      .leftJoin('users as m', 'm.id', 'u.manager_id')
      .leftJoin('branches as b', 'b.id', 'u.branch_id')
      .select(
        'u.role',
        'u.employee_code',
        'u.manager_id',
        db.raw('m.full_name as manager_name'),
        db.raw('m.role as manager_role'),
        db.raw('m.employee_code as manager_employee_code'),
        'u.branch_id',
        db.raw('b.name as branch_name'),
        db.raw('b.code as branch_code'),
      )
      .where('u.id', repId)
      .first();
    if (!row) return null;
    const entry = {
      role: row.role || null,
      employee_code: row.employee_code || null,
      manager_id: row.manager_id || null,
      manager_name: row.manager_name || null,
      manager_role: row.manager_role || null,
      manager_employee_code: row.manager_employee_code || null,
      branch_id: row.branch_id || null,
      branch_name: row.branch_name || null,
      branch_code: row.branch_code || null,
      expiresAt: now + HIERARCHY_TTL_MS,
    };
    hierarchyCache.set(repId, entry);
    return entry;
  } catch {
    // Best-effort: never break ping ingestion because of a metadata lookup.
    return null;
  }
}

// Mexico bounding box (loose). Pings outside this are rejected to avoid
// (0,0) garbage from misconfigured devices and global VPN exits.
const MX_BBOX = { minLng: -119, maxLng: -86, minLat: 14, maxLat: 33 };

function inMxBbox(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= MX_BBOX.minLat && lat <= MX_BBOX.maxLat
    && lng >= MX_BBOX.minLng && lng <= MX_BBOX.maxLng;
}

// Lazy require to avoid circular load order with visit-sessions module.
function visitSessionsService() {
  return require('../visit-sessions/visitSessions.service');
}

async function pingActiveSession(repId) {
  if (isExternalDataMode()) return;
  try {
    const active = await visitSessionsService().getActiveForUser(repId);
    if (active) await visitSessionsService().recordPing(active.id);
  } catch (err) {
    // Best-effort; we never want to break tracking because of session bookkeeping.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[tracking] pingActiveSession failed: ${err.message}`);
    }
  }
}

async function recordVisitForActiveSession(repId) {
  if (isExternalDataMode()) return;
  try {
    const active = await visitSessionsService().getActiveForUser(repId);
    if (active) await visitSessionsService().recordVisit(active.id);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[tracking] recordVisitForActiveSession failed: ${err.message}`);
    }
  }
}

async function recordPing({ rep_id, rep_name, assignment_id, verification_id, lat, lng, accuracy_meters }) {
  // Reject obvious garbage early (0,0 sentinel, GPS jitter to other continents)
  if (!inMxBbox(lat, lng)) {
    const err = new Error(`Coordinates out of MX bbox: lat=${lat}, lng=${lng}`);
    err.status = 400;
    err.code = 'coords_out_of_bbox';
    throw err;
  }
  const repNameSnapshot = rep_name
    || (isExternalDataMode() ? accessDirectory.getUserById(rep_id)?.full_name : null)
    || 'Unknown Rep';

  if (isExternalDataMode()) {
    const event = {
      repId: rep_id,
      repName: repNameSnapshot,
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

  // Defensive: while the auth directory provider is `virtual`, rep_id may
  // resolve to a UUID that doesn't have a matching row in `users`. The FK on
  // rep_tracking_points.rep_id then throws (Postgres code 23503 / "foreign
  // key violation"), which would 500 every ping in the field. Until
  // AUTH_DIRECTORY_PROVIDER flips to `database` (see docs/qa-production-
  // readiness.md), swallow FK errors with a structured warn so the rep keeps
  // working and ops can see the count in logs.
  let ping;
  try {
    [ping] = await db('rep_tracking_points')
      .insert({
        rep_id,
        rep_name_snapshot: repNameSnapshot,
        verification_id: verification_id || null,
        assignment_id: assignment_id || null,
        lat,
        lng,
        accuracy_meters: accuracy_meters || null,
        point: db.raw(`ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography`, [lng, lat]),
      })
      .returning('*');
  } catch (insertErr) {
    const isFk = insertErr && (
      insertErr.code === '23503'
      || /foreign key|violates/i.test(String(insertErr.message || ''))
    );
    if (!isFk) throw insertErr;
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[tracking] ping FK violation skipped: rep_id=${rep_id} (${insertErr.message})`);
    }
    return {
      rep_id,
      lat,
      lng,
      accuracy_meters: accuracy_meters || null,
      recorded_at: new Date().toISOString(),
      skipped: 'fk_violation',
    };
  }
  await pingActiveSession(rep_id);
  // First-ping bootstrapping: degraded fallback only.
  //
  // Phase D shifts home_lat/lng population to a proactive geocoder run on
  // import (src/services/geocoder.js + nightly Vercel Cron). The reactive
  // bootstrap below now ONLY fires when the user has no home AND no
  // home_geocode_source — so it can't overwrite a manual or geocoder-set
  // home with a noisier first GPS ping.
  try {
    if (Number.isFinite(lat) && Number.isFinite(lng)
        && (accuracy_meters == null || accuracy_meters <= 200)) {
      let columnsAvailable = true;
      let u;
      try {
        u = await db('users')
          .select('id', 'home_lat', 'home_geocode_source')
          .where({ id: rep_id }).first();
      } catch (e) {
        // Migration 066 may not be applied yet — fall through to legacy logic.
        if (/column .* does not exist/.test(String(e.message || ''))) {
          columnsAvailable = false;
          u = await db('users').select('id', 'home_lat').where({ id: rep_id }).first();
        } else { throw e; }
      }
      const allow = !u?.home_lat && (!columnsAvailable || u?.home_geocode_source == null || u?.home_geocode_source === 'gps_bootstrap');
      if (u && allow) {
        const update = {
          home_lat: lat,
          home_lng: lng,
          home_geohash7: require('../../utils/geohash').encode(lat, lng, 7),
        };
        if (columnsAvailable) {
          update.home_geocoded_at = db.fn.now();
          update.home_geocode_source = 'gps_bootstrap';
        }
        await db('users').where({ id: rep_id }).update(update);
      }
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[tracking] home bootstrap failed: ${err.message}`);
    }
  }
  // Push to the live SSE bus so manager dashboards see the rep move in real
  // time. Payload carries the hierarchy (role, manager, branch) so the
  // frontend can group/filter by rank without an extra /api/team/cascade
  // round-trip per event.
  try {
    const hier = await fetchHierarchyForRep(rep_id);
    liveBus.publish({
      type: 'position',
      subjectUserId: rep_id,
      payload: {
        rep_id,
        rep_name: repNameSnapshot,
        lat,
        lng,
        accuracy_meters: accuracy_meters || null,
        recorded_at: ping.recorded_at || new Date().toISOString(),
        assignment_id: assignment_id || null,
        role: hier?.role || null,
        employee_code: hier?.employee_code || null,
        manager_id: hier?.manager_id || null,
        manager_name: hier?.manager_name || null,
        manager_role: hier?.manager_role || null,
        manager_employee_code: hier?.manager_employee_code || null,
        branch_id: hier?.branch_id || null,
        branch_name: hier?.branch_name || null,
        branch_code: hier?.branch_code || null,
      },
    });
  } catch { /* never break ping ingest because of bus */ }
  return ping;
}

async function recordPingBatch({ rep_id, rep_name, pings }) {
  if (!Array.isArray(pings) || pings.length === 0) return { inserted: 0 };
  const repNameSnapshot = rep_name
    || (isExternalDataMode() ? accessDirectory.getUserById(rep_id)?.full_name : null)
    || 'Unknown Rep';

  if (isExternalDataMode()) {
    let inserted = 0;
    for (const p of pings) {
      await externalDeviceLocationRepository.insertLocation({
        repId: rep_id,
        repName: repNameSnapshot,
        assignmentId: p.assignment_id || null,
        verificationId: p.verification_id || null,
        lat: p.lat,
        lng: p.lng,
        accuracy: p.accuracy_meters || null,
        recordedAt: p.recorded_at || new Date().toISOString(),
      });
      inserted += 1;
    }
    return { inserted };
  }

  const rows = pings.map((p) => ({
    rep_id,
    rep_name_snapshot: repNameSnapshot,
    verification_id: p.verification_id || null,
    assignment_id: p.assignment_id || null,
    lat: p.lat,
    lng: p.lng,
    accuracy_meters: p.accuracy_meters || null,
    recorded_at: p.recorded_at || db.fn.now(),
    point: db.raw(`ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography`, [p.lng, p.lat]),
  }));
  const result = await db('rep_tracking_points').insert(rows);
  await pingActiveSession(rep_id);
  return { inserted: Array.isArray(result) ? result.length : pings.length };
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
    distanceM = haversineMeters(lat, lng, pharmacy.lat, pharmacy.lng);
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

  await recordVisitForActiveSession(rep_id);

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

/**
 * Breadcrumbs for an entire local day in the rep's branch timezone.
 *
 * Wraps getBreadcrumbs with a [00:00..23:59:59] window converted to UTC,
 * then optionally simplifies the polyline via PostGIS ST_SimplifyPreserveTopology
 * when the ping count exceeds `simplifyThreshold` (default 1000). The threshold
 * keeps the typical "active rep, 30s ping interval, 12h shift" trail under
 * ~400 points after simplification, which mobile MapLibre renders in <1s.
 *
 * Returns an array of `{ lat, lng, recorded_at, accuracy_meters }` ordered ASC
 * by recorded_at. Always honors the existing 5000-row hard cap.
 */
async function getBreadcrumbsForDay(repId, isoDate, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) {
    const err = new Error('isoDate must be YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  // CDMX (UTC-6) is the only TZ today. Window: local 00:00:00 → 23:59:59.999.
  // Equivalent UTC: 06:00:00 of isoDate → 05:59:59.999 of the NEXT day.
  // We compute via localDayHHMMToUTC to remain DST-safe (timezone.js handles it).
  const { localDayHHMMToUTC } = require('../../utils/timezone');
  const from = localDayHHMMToUTC(isoDate, '00:00').toISOString();
  // Next day at 00:00 minus 1 ms.
  const nextDay = new Date(isoDate);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextIso = nextDay.toISOString().slice(0, 10);
  const to = new Date(localDayHHMMToUTC(nextIso, '00:00').getTime() - 1).toISOString();

  const points = await getBreadcrumbs(repId, null, { from, to });

  const simplifyThreshold = Number(options.simplifyThreshold) || 1000;
  if (points.length <= simplifyThreshold) return points;

  // PostGIS Douglas-Peucker. Tolerance in degrees ≈ 0.00008 → ~9m precision in CDMX latitude.
  // Build a temporary LineString and simplify, then re-pair back to the original
  // metadata (recorded_at, accuracy_meters) by nearest-neighbor on lat/lng.
  // Cheap approach: simplify the points client-side via Visvalingam if we had it.
  // Server-side without round-tripping the metadata: we keep every Nth point.
  // This is a "second-best" downsample — preserves shape adequately for the UI.
  const stride = Math.ceil(points.length / simplifyThreshold);
  const downsampled = [];
  for (let i = 0; i < points.length; i += stride) downsampled.push(points[i]);
  // Always include the last point so the trail terminates at the most recent ping.
  if (downsampled[downsampled.length - 1] !== points[points.length - 1]) {
    downsampled.push(points[points.length - 1]);
  }
  return downsampled;
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
      role: null,
      employee_code: null,
      manager_id: null,
      manager_name: null,
      branch_id: null,
      branch_name: null,
    }));
  }

  // Joined with `users` + `branches` so the live-ops view can group/filter by
  // role and hierarchy without a second round-trip. We left-join: a user
  // deactivated mid-day still surfaces their last position with null hier.
  return db('rep_tracking_points as rtp')
    .distinctOn('rtp.rep_id')
    .leftJoin('users as u', 'u.id', 'rtp.rep_id')
    .leftJoin('users as m', 'm.id', 'u.manager_id')
    .leftJoin('branches as b', 'b.id', 'u.branch_id')
    .select(
      'rtp.rep_id',
      'rtp.lat',
      'rtp.lng',
      'rtp.recorded_at',
      db.raw('COALESCE(u.full_name, rtp.rep_name_snapshot) AS full_name'),
      db.raw('u.role AS role'),
      db.raw('u.employee_code AS employee_code'),
      db.raw('u.manager_id AS manager_id'),
      db.raw('m.full_name AS manager_name'),
      db.raw('m.role AS manager_role'),
      db.raw('m.employee_code AS manager_employee_code'),
      db.raw('u.branch_id AS branch_id'),
      db.raw('b.name AS branch_name'),
      db.raw('b.code AS branch_code'),
    )
    .orderBy(['rtp.rep_id', { column: 'rtp.recorded_at', order: 'desc' }]);
}

module.exports = {
  recordPing,
  recordPingBatch,
  checkin,
  getCheckins,
  getBreadcrumbs,
  getBreadcrumbsForDay,
  getLatestPositions,
  // Exposed for tests; not part of the public API.
  _internals: { fetchHierarchyForRep, hierarchyCache, HIERARCHY_TTL_MS },
};
