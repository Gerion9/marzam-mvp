const config = require('../../config');
const getExternalDatabase = require('../../config/externalDatabase');

const FLEX = {
  repId: 'flex_parameter_1',
  repName: 'flex_parameter_2',
  waveId: 'flex_parameter_3',
  assignmentStatus: 'flex_parameter_4',
  visitStatus: 'flex_parameter_5',
  regularizationStatus: 'flex_parameter_6',
  comment: 'flex_parameter_7',
  campaignObjective: 'flex_parameter_8',
  priority: 'flex_parameter_9',
  assignedAt: 'flex_parameter_10',
  visitedAt: 'flex_parameter_11',
  routeOrder: 'flex_parameter_12',
  metadata: 'flex_parameter_13',
  checkinLat: 'flex_parameter_14',
  checkinLng: 'flex_parameter_15',
};

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function timestampValue(row) {
  return new Date(
    row.updated_at
    || row.created_at
    || row.visited_at
    || row.assigned_at
    || 0,
  ).getTime();
}

function buildAssignmentId(row, metadata) {
  if (metadata.assignment_id) return String(metadata.assignment_id);
  const waveId = normalizeText(row[FLEX.waveId]) || 'default-wave';
  const repId = normalizeText(row[FLEX.repId]) || 'unassigned';
  return `${waveId}::${repId}`;
}

function normalizeSurveyRow(rawRow) {
  const metadata = safeJsonParse(rawRow[FLEX.metadata], {});
  const repId = normalizeText(rawRow[FLEX.repId]);
  const waveId = normalizeText(rawRow[FLEX.waveId]) || 'default-wave';

  return {
    raw: rawRow,
    id: rawRow.id != null ? String(rawRow.id) : buildAssignmentId(rawRow, metadata),
    assignment_id: buildAssignmentId(rawRow, metadata),
    pharmacy_id: normalizeText(rawRow.id_pois),
    rep_id: repId,
    rep_name: normalizeText(rawRow[FLEX.repName]),
    wave_id: waveId,
    campaign_objective: normalizeText(rawRow[FLEX.campaignObjective]),
    assignment_status: normalizeText(rawRow[FLEX.assignmentStatus]) || 'assigned',
    visit_status: normalizeText(rawRow[FLEX.visitStatus]) || 'pending',
    regularization_status: normalizeText(rawRow[FLEX.regularizationStatus]) || 'pending',
    priority: normalizeText(rawRow[FLEX.priority]) || 'normal',
    route_order: normalizeNumber(rawRow[FLEX.routeOrder]),
    assigned_at: normalizeText(rawRow[FLEX.assignedAt]),
    due_at: normalizeText(metadata.due_at),
    visited_at: normalizeText(rawRow[FLEX.visitedAt]),
    checkin_lat: normalizeNumber(rawRow[FLEX.checkinLat]),
    checkin_lng: normalizeNumber(rawRow[FLEX.checkinLng]),
    distance_to_pharmacy_m: normalizeNumber(metadata.distance_to_pharmacy_m),
    photo_url: normalizeText(rawRow.url),
    comment: normalizeText(rawRow[FLEX.comment]),
    contact_name: normalizeText(metadata.contact_name),
    contact_phone: normalizeText(metadata.contact_phone),
    order_potential: normalizeNumber(metadata.order_potential),
    created_by: normalizeText(metadata.created_by),
    created_at: rawRow.created_at || null,
    updated_at: rawRow.updated_at || null,
  };
}

async function loadRawRows(limit = 20000) {
  if (config.externalData.provider !== 'sql') {
    throw new Error('field_survey_pois integration currently supports EXTERNAL_DATA_PROVIDER=sql only.');
  }

  const db = getExternalDatabase();
  const result = await db.raw(
    `SELECT * FROM ${config.externalData.fieldSurveyTable} ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST, id DESC LIMIT ?`,
    [Math.min(Number(limit) || 20000, config.limits.fieldSurveyMax)],
  );
  return result.rows || [];
}

function applyFilters(rows, filters = {}) {
  let filtered = rows.filter((row) => row.pharmacy_id);

  if (filters.rep_id) filtered = filtered.filter((row) => row.rep_id === String(filters.rep_id));
  if (filters.assignment_id) filtered = filtered.filter((row) => row.assignment_id === String(filters.assignment_id));
  if (filters.pharmacy_id) filtered = filtered.filter((row) => row.pharmacy_id === String(filters.pharmacy_id));
  if (filters.wave_id) filtered = filtered.filter((row) => row.wave_id === String(filters.wave_id));
  if (filters.visit_status) filtered = filtered.filter((row) => row.visit_status === filters.visit_status);
  if (filters.assignment_status) filtered = filtered.filter((row) => row.assignment_status === filters.assignment_status);
  if (filters.has_photo === 'true') filtered = filtered.filter((row) => !!row.photo_url);
  if (filters.has_photo === 'false') filtered = filtered.filter((row) => !row.photo_url);
  if (filters.has_comment === 'true') filtered = filtered.filter((row) => !!String(row.comment || '').trim());
  if (filters.has_comment === 'false') filtered = filtered.filter((row) => !String(row.comment || '').trim());
  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    filtered = filtered.filter((row) =>
      String(row.comment || '').toLowerCase().includes(q)
      || String(row.rep_name || '').toLowerCase().includes(q)
      || String(row.pharmacy_id || '').toLowerCase().includes(q));
  }

  return filtered;
}

async function listHistory(filters = {}) {
  const rows = (await loadRawRows(filters.limit || 5000)).map(normalizeSurveyRow);
  const filtered = applyFilters(rows, filters);
  filtered.sort((a, b) => timestampValue(b) - timestampValue(a));
  return filtered.slice(0, Math.min(Number(filters.limit) || filtered.length, 5000));
}

async function listCurrentState(filters = {}) {
  const history = await listHistory({ ...filters, limit: filters.limit || 20000 });
  const latestByPharmacy = new Map();

  for (const row of history) {
    const existing = latestByPharmacy.get(row.pharmacy_id);
    if (!existing || timestampValue(row) > timestampValue(existing)) {
      latestByPharmacy.set(row.pharmacy_id, row);
    }
  }

  const rows = Array.from(latestByPharmacy.values());
  rows.sort((a, b) => timestampValue(b) - timestampValue(a));
  return rows;
}

function serializeEvent(event) {
  const now = new Date().toISOString();
  const metadata = {
    assignment_id: normalizeText(event.assignmentId),
    due_at: normalizeText(event.dueAt),
    order_potential: event.orderPotential ?? null,
    distance_to_pharmacy_m: event.distanceMeters ?? null,
    contact_name: normalizeText(event.contactName),
    contact_phone: normalizeText(event.contactPhone),
    created_by: normalizeText(event.createdBy),
  };

  return {
    id_pois: normalizeText(event.pharmacyId),
    [FLEX.repId]: normalizeText(event.repId),
    [FLEX.repName]: normalizeText(event.repName),
    [FLEX.waveId]: normalizeText(event.waveId) || 'default-wave',
    [FLEX.assignmentStatus]: normalizeText(event.assignmentStatus) || 'assigned',
    [FLEX.visitStatus]: normalizeText(event.visitStatus) || 'pending',
    [FLEX.regularizationStatus]: normalizeText(event.regularizationStatus) || 'pending',
    [FLEX.comment]: normalizeText(event.comment),
    [FLEX.campaignObjective]: normalizeText(event.campaignObjective),
    [FLEX.priority]: normalizeText(event.priority) || 'normal',
    [FLEX.assignedAt]: normalizeText(event.assignedAt) || now,
    [FLEX.visitedAt]: normalizeText(event.visitedAt),
    [FLEX.routeOrder]: event.routeOrder == null ? null : String(event.routeOrder),
    [FLEX.metadata]: JSON.stringify(metadata),
    [FLEX.checkinLat]: event.checkinLat == null ? null : String(event.checkinLat),
    [FLEX.checkinLng]: event.checkinLng == null ? null : String(event.checkinLng),
    url: normalizeText(event.photoUrl),
    created_at: now,
    updated_at: now,
  };
}

async function insertEvents(events) {
  if (!events.length) return [];
  const db = getExternalDatabase();
  const rows = events.map(serializeEvent);
  await db(config.externalData.fieldSurveyTable).insert(rows);
  return events;
}

module.exports = {
  listHistory,
  listCurrentState,
  insertEvents,
};
