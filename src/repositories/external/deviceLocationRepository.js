const fs = require('fs/promises');
const path = require('path');
const config = require('../../config');
const getBigQueryClient = require('../../integrations/bigquery/client');
const getExternalDatabase = require('../../config/externalDatabase');
const accessDirectory = require('../../services/accessDirectory');
const { DEVICE_LOCATION_CANDIDATES } = require('./semanticMaps');
const {
  buildSemanticMap,
  pickExistingColumns,
  mapRawRow,
  coerceNumber,
} = require('./mappingUtils');
const { parseBigQueryTableRef } = require('./tableRef');
const { getDeviceLocationsTable } = require('./tableScope');

const cachedLocationMaps = {};
const remoteStoreFlags = {};
const LOCAL_TRACKING_PATH = config.externalData.deviceLocationsFallbackPath || path.resolve(process.cwd(), 'data', 'device-locations-runtime.json');

function parseSqlTableRef(tableRef) {
  const parts = String(tableRef || '').split('.').filter(Boolean);
  if (parts.length === 1) return { schema: 'public', table: parts[0] };
  return { schema: parts[parts.length - 2], table: parts[parts.length - 1] };
}

async function readLocalRows() {
  try {
    const raw = await fs.readFile(LOCAL_TRACKING_PATH, 'utf8');
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function writeLocalRows(rows) {
  await fs.mkdir(path.dirname(LOCAL_TRACKING_PATH), { recursive: true });
  await fs.writeFile(LOCAL_TRACKING_PATH, JSON.stringify(rows, null, 2), 'utf8');
}

async function loadRawRows(limit = 10000) {
  const tableName = getDeviceLocationsTable();
  if (!tableName) return null;

  if (config.externalData.provider === 'bigquery') {
    try {
      const client = getBigQueryClient();
      const tableRef = parseBigQueryTableRef(
        tableName,
        config.bigquery.projectId || config.bigquery.serviceAccount?.project_id,
      );
      const [rows] = await client.query({
        query: `SELECT * FROM ${tableRef.sqlRef} LIMIT @limit`,
        params: { limit },
      });
      return rows;
    } catch {
      return null;
    }
  }

  try {
    const db = getExternalDatabase();
    const result = await db.raw(`SELECT * FROM ${tableName} LIMIT ?`, [limit]);
    return result.rows || [];
  } catch {
    return null;
  }
}

async function getSemanticMap() {
  const tableName = getDeviceLocationsTable();
  if (cachedLocationMaps[tableName]) return cachedLocationMaps[tableName];
  const rows = await loadRawRows(1);
  let columns = rows?.[0] ? Object.keys(rows[0]) : Object.values(config.externalData.deviceLocationsSchemaMap || {});
  if (!columns.length && config.externalData.provider === 'sql') {
    const db = getExternalDatabase();
    const tableRef = parseSqlTableRef(tableName);
    const result = await db('information_schema.columns')
      .select('column_name')
      .where({ table_schema: tableRef.schema, table_name: tableRef.table })
      .orderBy('ordinal_position', 'asc');
    columns = result.map((row) => row.column_name);
  }
  if (!columns.length) return null;
  cachedLocationMaps[tableName] = buildSemanticMap(columns, DEVICE_LOCATION_CANDIDATES, config.externalData.deviceLocationsSchemaMap);
  return cachedLocationMaps[tableName];
}

async function resolveStoreMode() {
  const tableName = getDeviceLocationsTable();
  if (remoteStoreFlags[tableName] != null) return remoteStoreFlags[tableName];
  const semanticMap = await getSemanticMap();
  remoteStoreFlags[tableName] = !!semanticMap;
  return remoteStoreFlags[tableName];
}

function normalizeLocationRow(rawRow, semanticMap) {
  const mapped = mapRawRow(rawRow, semanticMap);
  const user = accessDirectory.getUserByDbUserId(mapped.repId);
  return {
    rep_id: user?.id || (mapped.repId ? String(mapped.repId) : null),
    rep_name: user?.full_name || mapped.repName || null,
    assignment_id: mapped.assignmentId ? String(mapped.assignmentId) : null,
    verification_id: mapped.verificationId ? String(mapped.verificationId) : null,
    lat: coerceNumber(mapped.lat),
    lng: coerceNumber(mapped.lng),
    accuracy_meters: coerceNumber(mapped.accuracy),
    recorded_at: mapped.recordedAt || null,
  };
}

async function listLocations(limit = 10000) {
  if (await resolveStoreMode()) {
    const semanticMap = await getSemanticMap();
    return (await loadRawRows(limit))
      .map((row) => normalizeLocationRow(row, semanticMap))
      .filter((row) => row.rep_id && row.lat != null && row.lng != null);
  }

  const rows = await readLocalRows();
  return rows
    .slice(-Math.min(Number(limit) || 10000, 50000))
    .filter((row) => row.rep_id && row.lat != null && row.lng != null);
}

async function insertLocation(event) {
  if (await resolveStoreMode()) {
    const semanticMap = await getSemanticMap();
    const translatedEvent = {
      ...event,
      repId: accessDirectory.getDbUserId(event.repId) || event.repId,
    };
    const row = pickExistingColumns(translatedEvent, semanticMap);

    const tableName = getDeviceLocationsTable();
    if (config.externalData.provider === 'bigquery') {
      const client = getBigQueryClient();
      const tableRef = parseBigQueryTableRef(
        tableName,
        config.bigquery.projectId || config.bigquery.serviceAccount?.project_id,
      );
      await client.dataset(tableRef.datasetId, { projectId: tableRef.projectId }).table(tableRef.tableId).insert([row]);
    } else {
      const db = getExternalDatabase();
      await db(tableName).insert(row);
    }

    return event;
  }

  if (config.env === 'production') {
    const err = new Error('Remote device_locations table is not available and local fallback is disabled in production');
    err.status = 503;
    throw err;
  }

  const rows = await readLocalRows();
  rows.push({
    rep_id: event.repId ? String(event.repId) : null,
    rep_name: event.repName || null,
    assignment_id: event.assignmentId ? String(event.assignmentId) : null,
    verification_id: event.verificationId ? String(event.verificationId) : null,
    lat: coerceNumber(event.lat),
    lng: coerceNumber(event.lng),
    accuracy_meters: coerceNumber(event.accuracy_meters ?? event.accuracy),
    recorded_at: event.recordedAt || new Date().toISOString(),
  });
  await writeLocalRows(rows.slice(-50000));
  return event;
}

module.exports = {
  listLocations,
  insertLocation,
};
