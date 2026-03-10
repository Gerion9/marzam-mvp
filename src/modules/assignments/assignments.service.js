const db = require('../../config/database');
const { assertTransition } = require('./assignments.stateMachine');
const { orderStops } = require('../../utils/routeOrdering');
const { balancedSpatialClusters, clusterStats } = require('../../utils/spatialDistribution');
const { buildDirectionsUrl } = require('../../utils/googleMaps');
const verificationService = require('../verifications/verifications.service');
const externalPoiRepository = require('../../repositories/external/poiRepository');
const externalFieldSurveyRepository = require('../../repositories/external/fieldSurveyRepository');
const { isExternalDataMode } = require('../../repositories/runtime');
const { buildAssignmentId, buildStopId } = require('../externalData/externalAssignmentIds');
const accessDirectory = require('../../services/accessDirectory');

async function getRepNameMap(repIds) {
  if (isExternalDataMode()) {
    return new Map(repIds
      .map((id) => accessDirectory.getUserById(id))
      .filter(Boolean)
      .map((user) => [String(user.id), user.full_name]));
  }

  if (!repIds.length) return new Map();
  const reps = await db('users').select('id', 'full_name').whereIn('id', repIds);
  return new Map(reps.map((row) => [String(row.id), row.full_name]));
}

async function listExternalCurrentAssignments(filters = {}) {
  const [currentRows, poiRows] = await Promise.all([
    externalFieldSurveyRepository.listCurrentState({ rep_id: filters.rep_id, limit: 20000 }),
    externalPoiRepository.list({ municipality: filters.municipality, limit: 5000 }),
  ]);
  const poiById = new Map(poiRows.map((row) => [String(row.id), row]));
  const repNameMap = await getRepNameMap(currentRows.map((row) => row.rep_id).filter(Boolean));
  const grouped = new Map();

  for (const row of currentRows) {
    if (row.assignment_status === 'cancelled') continue;
    if (filters.status && row.assignment_status !== filters.status) continue;
    const groupId = row.assignment_id || buildAssignmentId({ wave_id: row.wave_id, rep_id: row.rep_id });
    if (!grouped.has(groupId)) {
      grouped.set(groupId, {
        id: groupId,
        rep_id: row.rep_id,
        rep_name: row.rep_name || repNameMap.get(String(row.rep_id)) || null,
        wave_id: row.wave_id,
        campaign_objective: row.campaign_objective || 'Prospecting',
        priority: row.priority || 'normal',
        due_date: row.due_at || null,
        status: row.assignment_status || 'assigned',
        created_at: row.assigned_at || row.visited_at || new Date().toISOString(),
        polygon_geojson: null,
        stops: [],
      });
    }

    const assignment = grouped.get(groupId);
    const poi = poiById.get(String(row.pharmacy_id));
    assignment.stops.push({
      id: buildStopId({
        assignment_id: groupId,
        pharmacy_id: row.pharmacy_id,
        route_order: row.route_order || assignment.stops.length + 1,
      }),
      assignment_id: groupId,
      pharmacy_id: row.pharmacy_id,
      route_order: row.route_order || assignment.stops.length + 1,
      stop_status: row.assignment_status === 'completed' ? 'completed' : row.assignment_status === 'cancelled' ? 'skipped' : 'pending',
      name: poi?.name || row.pharmacy_id,
      address: poi?.address || null,
      lng: poi?.lng || null,
      lat: poi?.lat || null,
    });
  }

  return Array.from(grouped.values())
    .map((assignment) => {
      assignment.stops.sort((a, b) => Number(a.route_order || 0) - Number(b.route_order || 0));
      assignment.google_maps_url = buildDirectionsUrl(assignment.stops.filter((stop) => stop.lat != null && stop.lng != null));
      assignment.total_stops = assignment.stops.length;
      assignment.completed_stops = assignment.stops.filter((stop) => stop.stop_status === 'completed').length;
      if (assignment.completed_stops >= assignment.total_stops && assignment.total_stops > 0) {
        assignment.status = 'completed';
      } else if (assignment.stops.some((stop) => stop.stop_status !== 'pending')) {
        assignment.status = 'in_progress';
      }
      return assignment;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

async function createExternal(payload) {
  const pharmacies = await externalPoiRepository.list({ limit: 5000 });
  const selectedIds = new Set((payload.pharmacy_ids || []).map((value) => String(value)));
  const selected = pharmacies.filter((row) => selectedIds.has(String(row.id)));
  if (!selected.length) {
    const err = new Error('No pharmacies selected for assignment');
    err.status = 422;
    throw err;
  }

  const waveId = payload.wave_id || `wave-${new Date().toISOString().slice(0, 10)}`;
  const assignmentId = buildAssignmentId({ wave_id: waveId, rep_id: payload.rep_id });
  const ordered = orderStops(selected);
  const stops = ordered.map((pharmacy, idx) => ({
    id: buildStopId({ assignment_id: assignmentId, pharmacy_id: pharmacy.id, route_order: idx + 1 }),
    assignment_id: assignmentId,
    pharmacy_id: pharmacy.id,
    route_order: idx + 1,
    stop_status: 'pending',
  }));

  const assignment = {
    id: assignmentId,
    rep_id: payload.rep_id || null,
    campaign_objective: payload.campaign_objective,
    priority: payload.priority || 'normal',
    due_date: payload.due_date || null,
    created_by: payload.created_by,
    wave_id: waveId,
    status: payload.rep_id ? 'assigned' : 'unassigned',
  };

  if (assignment.rep_id) {
    await verificationService.createForAssignment({
      assignment,
      stops,
      wave_id: waveId,
    });
  } else {
    await externalFieldSurveyRepository.insertEvents(stops.map((stop) => ({
      assignmentId,
      pharmacyId: stop.pharmacy_id,
      repId: null,
      waveId,
      campaignObjective: payload.campaign_objective,
      assignmentStatus: 'unassigned',
      visitStatus: 'pending',
      regularizationStatus: 'pending',
      priority: assignment.priority,
      routeOrder: stop.route_order,
      assignedAt: new Date().toISOString(),
      dueAt: assignment.due_date,
      createdBy: payload.created_by,
    })));
  }

  return {
    ...assignment,
    stops,
    total_stops: stops.length,
    completed_stops: 0,
    google_maps_url: buildDirectionsUrl(ordered),
    polygon_geojson: null,
  };
}

async function getByIdExternal(id) {
  const assignments = await listExternalCurrentAssignments({});
  const assignment = assignments.find((row) => row.id === id);
  if (!assignment) {
    const err = new Error('Assignment not found');
    err.status = 404;
    throw err;
  }
  return assignment;
}

async function updateStatusExternal(id, newStatus) {
  const assignment = await getByIdExternal(id);
  assertTransition(assignment.status, newStatus);
  const repNameMap = await getRepNameMap(assignment.rep_id ? [assignment.rep_id] : []);
  await externalFieldSurveyRepository.insertEvents(assignment.stops.map((stop) => ({
    assignmentId: assignment.id,
    pharmacyId: stop.pharmacy_id,
    repId: assignment.rep_id,
    repName: repNameMap.get(String(assignment.rep_id)) || null,
    waveId: assignment.wave_id,
    campaignObjective: assignment.campaign_objective,
    assignmentStatus: newStatus,
    visitStatus: newStatus === 'completed' ? 'visited' : 'pending',
    regularizationStatus: newStatus === 'completed' ? 'verified' : 'pending',
    priority: assignment.priority,
    routeOrder: stop.route_order,
    assignedAt: assignment.created_at,
    dueAt: assignment.due_date,
    visitedAt: newStatus === 'completed' ? new Date().toISOString() : null,
  })));
  return { before: assignment, after: { ...assignment, status: newStatus } };
}

async function checkOverlapExternal(polygon_geojson) {
  const selected = await externalPoiRepository.list({ polygon: polygon_geojson, limit: 5000 });
  const selectedIds = new Set(selected.map((row) => String(row.id)));
  const currentRows = await externalFieldSurveyRepository.listCurrentState({ limit: 20000 });
  const overlaps = currentRows
    .filter((row) => selectedIds.has(String(row.pharmacy_id)))
    .filter((row) => ['assigned', 'in_progress'].includes(row.assignment_status))
    .map((row) => ({
      id: row.assignment_id,
      status: row.assignment_status,
      rep_id: row.rep_id,
    }));

  const unique = new Map(overlaps.map((row) => [`${row.id}::${row.rep_id}`, row]));
  return Array.from(unique.values());
}

async function reassignExternal(id, data) {
  const assignment = await getByIdExternal(id);
  await verificationService.syncAssignmentReassignment({
    assignmentId: id,
    rep_id: data.rep_id,
    priority: data.priority,
    due_date: data.due_date,
  });

  const after = {
    ...assignment,
    rep_id: data.rep_id !== undefined ? data.rep_id : assignment.rep_id,
    priority: data.priority || assignment.priority,
    due_date: data.due_date !== undefined ? data.due_date : assignment.due_date,
    status: data.rep_id ? 'assigned' : 'unassigned',
  };
  return { before: assignment, after };
}

async function distributeWaveExternal({
  municipality,
  rep_ids,
  campaign_objective,
  priority,
  due_date,
  created_by,
  wave_id,
  max_pharmacies_per_rep,
  dry_run,
}) {
  let targetRepIds = rep_ids;
  if (!Array.isArray(targetRepIds) || !targetRepIds.length) {
    targetRepIds = accessDirectory.listFieldReps().map((user) => user.id);
  }

  if (!targetRepIds.length) {
    const err = new Error('At least one active field rep is required');
    err.status = 422;
    throw err;
  }

  const currentRows = await externalFieldSurveyRepository.listCurrentState({ limit: 20000 });
  const activeIds = new Set(currentRows
    .filter((row) => ['assigned', 'in_progress', 'reassigned'].includes(row.assignment_status))
    .map((row) => String(row.pharmacy_id)));
  const allPharmacies = await externalPoiRepository.list({ municipality, limit: 5000 });
  const pharmacies = allPharmacies.filter((row) => !activeIds.has(String(row.id)));

  if (!pharmacies.length) {
    const err = new Error('No pharmacies available for wave distribution');
    err.status = 422;
    throw err;
  }

  const resolvedWaveId = wave_id || `ecatepec-wave-${new Date().toISOString().slice(0, 10)}`;
  const k = Math.min(targetRepIds.length, pharmacies.length);
  const clusters = balancedSpatialClusters(pharmacies, k);

  if (dry_run) {
    const stats = clusterStats(clusters);
    return {
      dry_run: true,
      wave_id: resolvedWaveId,
      rep_count: targetRepIds.length,
      pharmacy_count: pharmacies.length,
      clusters_created: clusters.length,
      ...stats,
      cluster_sizes: clusters.map((c, i) => ({
        rep_id: targetRepIds[i % targetRepIds.length],
        size: c.length,
      })),
    };
  }

  const assignments = [];
  for (let index = 0; index < clusters.length; index += 1) {
    const cluster = clusters[index];
    if (!cluster.length) continue;
    const orderedStops = orderStops(cluster);
    const assignment = await createExternal({
      pharmacy_ids: orderedStops.map((row) => row.id),
      rep_id: targetRepIds[index % targetRepIds.length],
      campaign_objective,
      priority,
      due_date,
      created_by,
      wave_id: resolvedWaveId,
    });
    assignments.push(assignment);
  }

  return {
    wave_id: resolvedWaveId,
    rep_count: targetRepIds.length,
    pharmacy_count: pharmacies.length,
    assignments_created: assignments.length,
    assignments,
  };
}

async function createAssignmentWithStops(trx, {
  polygon_geojson,
  rep_id,
  campaign_objective,
  priority,
  due_date,
  visit_goal,
  pharmacy_ids,
  created_by,
  wave_id,
}) {
  const insertRow = {
    rep_id,
    campaign_objective,
    priority: priority || 'normal',
    due_date: due_date || null,
    visit_goal: visit_goal || pharmacy_ids.length,
    status: rep_id ? 'assigned' : 'unassigned',
    created_by,
  };

  if (polygon_geojson) {
    insertRow.polygon = trx.raw(
      `ST_SetSRID(ST_GeomFromGeoJSON(?), 4326)`,
      [JSON.stringify(polygon_geojson)],
    );
  }

  const [assignment] = await trx('territory_assignments')
    .insert(insertRow)
    .returning('*');

  const pharmacies = await trx('pharmacies')
    .select(
      'id',
      'name',
      trx.raw(`ST_X(coordinates::geometry) AS lng`),
      trx.raw(`ST_Y(coordinates::geometry) AS lat`),
    )
    .whereIn('id', pharmacy_ids);

  const ordered = orderStops(pharmacies);
  const stops = ordered.map((pharmacy, idx) => ({
    assignment_id: assignment.id,
    pharmacy_id: pharmacy.id,
    route_order: idx + 1,
    stop_status: 'pending',
  }));

  const insertedStops = await trx('assignment_stops').insert(stops).returning('*');

  if (rep_id) {
    await trx('pharmacies')
      .whereIn('id', pharmacy_ids)
      .update({ assigned_rep_id: rep_id, updated_at: trx.fn.now() });

    await verificationService.createForAssignment({
      trx,
      assignment,
      stops: insertedStops,
      wave_id: wave_id || null,
    });
  }

  const googleMapsUrl = buildDirectionsUrl(ordered);
  return { ...assignment, stops: insertedStops, google_maps_url: googleMapsUrl, wave_id: wave_id || null };
}

function chunkRows(rows, chunkSize) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

async function create(payload) {
  if (isExternalDataMode()) {
    return createExternal(payload);
  }
  return db.transaction(async (trx) => createAssignmentWithStops(trx, payload));
}

async function list(filters = {}) {
  if (isExternalDataMode()) {
    return listExternalCurrentAssignments(filters);
  }

  const q = db('territory_assignments as ta')
    .select(
      'ta.*',
      'u.full_name as rep_name',
      db.raw(`ST_AsGeoJSON(ta.polygon)::json AS polygon_geojson`),
      db.raw(`(SELECT count(*) FROM assignment_stops WHERE assignment_id = ta.id) AS total_stops`),
      db.raw(`(SELECT count(*) FROM assignment_stops WHERE assignment_id = ta.id AND stop_status = 'completed') AS completed_stops`),
    )
    .leftJoin('users as u', 'u.id', 'ta.rep_id');

  if (filters.rep_id) q.where('ta.rep_id', filters.rep_id);
  if (filters.status) q.where('ta.status', filters.status);

  q.orderBy('ta.created_at', 'desc');
  return q;
}

async function getById(id) {
  if (isExternalDataMode()) {
    return getByIdExternal(id);
  }

  const assignment = await db('territory_assignments').where({ id }).first();
  if (!assignment) {
    const err = new Error('Assignment not found');
    err.status = 404;
    throw err;
  }

  const stops = await db('assignment_stops as s')
    .join('pharmacies as p', 'p.id', 's.pharmacy_id')
    .select(
      's.*',
      'p.name',
      'p.address',
      db.raw(`ST_X(p.coordinates::geometry) AS lng`),
      db.raw(`ST_Y(p.coordinates::geometry) AS lat`),
    )
    .where('s.assignment_id', id)
    .orderBy('s.route_order', 'asc');

  const googleMapsUrl = buildDirectionsUrl(stops);

  return { ...assignment, stops, google_maps_url: googleMapsUrl };
}

async function updateStatus(id, newStatus, _userId) {
  if (isExternalDataMode()) {
    return updateStatusExternal(id, newStatus);
  }

  const assignment = await db('territory_assignments').where({ id }).first();
  if (!assignment) {
    const err = new Error('Assignment not found');
    err.status = 404;
    throw err;
  }

  assertTransition(assignment.status, newStatus);

  const [updated] = await db('territory_assignments')
    .where({ id })
    .update({ status: newStatus, updated_at: db.fn.now() })
    .returning('*');

  return { before: assignment, after: updated };
}

async function checkOverlap(polygon_geojson) {
  if (isExternalDataMode()) {
    return checkOverlapExternal(polygon_geojson);
  }

  const overlapping = await db('territory_assignments')
    .select('id', 'status', 'rep_id')
    .whereIn('status', ['assigned', 'in_progress'])
    .whereRaw(
      `ST_Intersects(polygon, ST_SetSRID(ST_GeomFromGeoJSON(?), 4326))`,
      [JSON.stringify(polygon_geojson)],
    );
  return overlapping;
}

async function reassign(id, data, _userId) {
  if (isExternalDataMode()) {
    return reassignExternal(id, data);
  }

  return db.transaction(async (trx) => {
    const assignment = await trx('territory_assignments').where({ id }).first();
    if (!assignment) {
      const err = new Error('Assignment not found');
      err.status = 404;
      throw err;
    }

    const updates = {};
    if (data.rep_id !== undefined) updates.rep_id = data.rep_id || null;
    if (data.campaign_objective) updates.campaign_objective = data.campaign_objective;
    if (data.priority) updates.priority = data.priority;
    if (data.due_date !== undefined) updates.due_date = data.due_date || null;
    if (data.visit_goal !== undefined) updates.visit_goal = data.visit_goal;

    if (data.rep_id && assignment.status === 'unassigned') {
      updates.status = 'assigned';
    }

    updates.updated_at = trx.fn.now();

    const [updated] = await trx('territory_assignments')
      .where({ id })
      .update(updates)
      .returning('*');

    if (data.rep_id !== undefined && data.rep_id !== assignment.rep_id) {
      const stopPharmacyIds = await trx('assignment_stops')
        .where({ assignment_id: id })
        .pluck('pharmacy_id');

      if (stopPharmacyIds.length) {
        await trx('pharmacies')
          .whereIn('id', stopPharmacyIds)
          .update({ assigned_rep_id: data.rep_id || null, updated_at: trx.fn.now() });
      }

      const existingVerificationCount = await trx('pharmacy_verifications')
        .where({ assignment_id: id })
        .count('id as count')
        .first();

      if (Number(existingVerificationCount?.count || 0) === 0 && data.rep_id) {
        const stops = await trx('assignment_stops')
          .where({ assignment_id: id })
          .orderBy('route_order', 'asc');
        await verificationService.createForAssignment({
          trx,
          assignment: updated,
          stops,
        });
      } else {
        await verificationService.syncAssignmentReassignment({
          trx,
          assignmentId: id,
          rep_id: data.rep_id,
          priority: data.priority,
          due_date: data.due_date,
        });
      }
    } else if (data.priority || data.due_date !== undefined) {
      await verificationService.syncAssignmentReassignment({
        trx,
        assignmentId: id,
        priority: data.priority,
        due_date: data.due_date,
      });
    }

    return { before: assignment, after: updated };
  });
}

async function distributeWave({
  municipality,
  rep_ids,
  campaign_objective,
  priority,
  due_date,
  created_by,
  wave_id,
  max_pharmacies_per_rep,
  dry_run,
}) {
  if (isExternalDataMode()) {
    return distributeWaveExternal({
      municipality,
      rep_ids,
      campaign_objective,
      priority,
      due_date,
      created_by,
      wave_id,
      max_pharmacies_per_rep,
      dry_run,
    });
  }

  return db.transaction(async (trx) => {
    let targetRepIds = rep_ids;
    if (!Array.isArray(targetRepIds) || !targetRepIds.length) {
      targetRepIds = await trx('users')
        .where({ role: 'field_rep', is_active: true })
        .orderBy('full_name', 'asc')
        .pluck('id');
    }

    if (!targetRepIds.length) {
      const err = new Error('At least one active field rep is required');
      err.status = 422;
      throw err;
    }

    const pharmacyQuery = trx('pharmacies as p')
      .select(
        'p.id',
        'p.name',
        'p.municipality',
        'p.state',
        trx.raw(`ST_X(p.coordinates::geometry) AS lng`),
        trx.raw(`ST_Y(p.coordinates::geometry) AS lat`),
      )
      .where({ 'p.is_independent': true })
      .whereIn('p.status', ['active', 'pending_review'])
      .whereNotExists(function excludeAlreadyActive() {
        this.select(1)
          .from('pharmacy_verifications as pv')
          .whereRaw('pv.pharmacy_id = p.id')
          .whereIn('pv.assignment_status', ['assigned', 'in_progress', 'reassigned']);
      });

    if (municipality) {
      pharmacyQuery.where('p.municipality', municipality);
    }

    const pharmacies = await pharmacyQuery.orderBy('p.name', 'asc');
    if (!pharmacies.length) {
      const err = new Error('No pharmacies available for wave distribution');
      err.status = 422;
      throw err;
    }

    const ordered = orderStops(pharmacies);
    const defaultChunkSize = Math.ceil(ordered.length / targetRepIds.length);
    const chunkSize = Math.max(1, Number(max_pharmacies_per_rep) || defaultChunkSize);
    const pharmacyChunks = chunkRows(ordered, chunkSize);

    const assignments = [];
    for (let index = 0; index < pharmacyChunks.length; index += 1) {
      const chunk = pharmacyChunks[index];
      if (!chunk.length) continue;
      const assignment = await createAssignmentWithStops(trx, {
        polygon_geojson: null,
        rep_id: targetRepIds[index % targetRepIds.length],
        campaign_objective,
        priority,
        due_date,
        visit_goal: chunk.length,
        pharmacy_ids: chunk.map((row) => row.id),
        created_by,
        wave_id: wave_id || `ecatepec-wave-${new Date().toISOString().slice(0, 10)}`,
      });
      assignments.push(assignment);
    }

    return {
      wave_id: wave_id || `ecatepec-wave-${new Date().toISOString().slice(0, 10)}`,
      rep_count: targetRepIds.length,
      pharmacy_count: ordered.length,
      assignments_created: assignments.length,
      assignments,
    };
  });
}

async function resetAllAssignments() {
  if (!isExternalDataMode()) {
    const err = new Error('Reset is only available in external data mode');
    err.status = 501;
    throw err;
  }

  const cancelled = await externalFieldSurveyRepository.cancelByRepNamePattern('Pilot Rep%');
  return { cancelled, message: `${cancelled} asignaciones desasignadas` };
}

module.exports = {
  create,
  list,
  getById,
  updateStatus,
  checkOverlap,
  reassign,
  distributeWave,
  resetAllAssignments,
};
