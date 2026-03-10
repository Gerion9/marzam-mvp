const fs = require('fs/promises');
const { v5: uuidv5 } = require('uuid');
const config = require('../../config');
const getBigQueryClient = require('../../integrations/bigquery/client');
const getExternalDatabase = require('../../config/externalDatabase');
const { POI_FIELD_CANDIDATES } = require('./semanticMaps');
const {
  buildSemanticMap,
  mapRawRow,
  coerceNumber,
  pointInPolygon,
  polygonBounds,
} = require('./mappingUtils');
const { parseBigQueryTableRef } = require('./tableRef');

let cachedPoiMapping;
let cachedLocalCatalog = null;
const POI_ID_NAMESPACE = 'd51d2b28-4f90-4af5-9d7b-cf3de8b82006';

function normalizeText(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function parsePointWkt(value) {
  const text = normalizeText(value);
  const match = text?.match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!match) return { lat: null, lng: null };
  return {
    lng: Number.parseFloat(match[1]),
    lat: Number.parseFloat(match[2]),
  };
}

function buildSyntheticPoiId(row) {
  const lat = coerceNumber(row.lat);
  const lng = coerceNumber(row.lng);
  const seed = [
    normalizeText(row.name),
    normalizeText(row.address),
    lat != null ? lat.toFixed(6) : '',
    lng != null ? lng.toFixed(6) : '',
  ].join('|');
  return uuidv5(seed, POI_ID_NAMESPACE);
}

async function loadLocalCatalog() {
  if (cachedLocalCatalog) return cachedLocalCatalog;
  const raw = await fs.readFile(config.externalData.poiCatalogPath, 'utf8');
  const parsed = JSON.parse(raw);
  cachedLocalCatalog = Array.isArray(parsed?.pharmacies) ? parsed.pharmacies : [];
  return cachedLocalCatalog;
}

async function loadRawRows(limit = 10000) {
  if (!config.externalData.poiTable) return null;

  if (config.externalData.provider === 'bigquery') {
    try {
      const client = getBigQueryClient();
      const tableRef = parseBigQueryTableRef(
        config.externalData.poiTable,
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
    const result = await db.raw(`SELECT * FROM ${config.externalData.poiTable} LIMIT ?`, [limit]);
    return result.rows || [];
  } catch {
    return null;
  }
}

async function getSemanticMap() {
  if (cachedPoiMapping !== undefined) return cachedPoiMapping;
  const rows = await loadRawRows(1);
  const columns = rows?.[0] ? Object.keys(rows[0]) : Object.values(config.externalData.poiSchemaMap || {});
  if (!columns.length) {
    cachedPoiMapping = null;
    return cachedPoiMapping;
  }
  cachedPoiMapping = buildSemanticMap(columns, POI_FIELD_CANDIDATES, config.externalData.poiSchemaMap);
  return cachedPoiMapping;
}

async function list(filters = {}) {
  const semanticMap = await getSemanticMap();
  let rows;

  if (semanticMap) {
    const rawRows = await loadRawRows(Math.min(Number(filters.limit) || 5000, 10000));
    rows = (rawRows || []).map((row) => {
      const normalized = mapRawRow(row, semanticMap);
      const parsedPoint = parsePointWkt(row.geometry_coords);
      const lat = coerceNumber(normalized.lat) ?? parsedPoint.lat;
      const lng = coerceNumber(normalized.lng) ?? parsedPoint.lng;
      const status = normalized.status === 'open' ? 'active' : normalized.status || 'active';
      return {
        ...row,
        id: normalized.id || buildSyntheticPoiId({
          name: normalized.name,
          address: normalized.address,
          lat,
          lng,
        }),
        name: normalized.name,
        address: normalized.address,
        municipality: normalized.municipality,
        state: normalized.state,
        lat,
        lng,
        status,
        verification_status: normalized.verificationStatus || 'unverified',
        contact_person: normalized.contactName || null,
        contact_phone: normalized.contactPhone || null,
        order_potential: coerceNumber(normalized.potential),
      };
    }).filter((row) => row.id && row.name && row.lat != null && row.lng != null);
  } else {
    rows = (await loadLocalCatalog()).map((row) => ({
      ...row,
      lat: coerceNumber(row.lat),
      lng: coerceNumber(row.lng),
    })).filter((row) => row.id && row.name && row.lat != null && row.lng != null);
  }

  if (filters.municipality) rows = rows.filter((row) => row.municipality === filters.municipality);
  if (filters.status) rows = rows.filter((row) => row.status === filters.status);
  if (filters.search) {
    const search = String(filters.search).toLowerCase();
    rows = rows.filter((row) =>
      String(row.name || '').toLowerCase().includes(search)
      || String(row.address || '').toLowerCase().includes(search));
  }
  if (filters.bbox) {
    const parts = Array.isArray(filters.bbox)
      ? filters.bbox
      : String(filters.bbox).split(',');
    const [west, south, east, north] = parts.map(Number);
    if ([west, south, east, north].every(Number.isFinite)) {
      rows = rows.filter((row) => row.lng >= west && row.lng <= east && row.lat >= south && row.lat <= north);
    }
  }
  if (filters.polygon) {
    const bounds = polygonBounds(filters.polygon);
    rows = rows
      .filter((row) => row.lng >= bounds.minLng && row.lng <= bounds.maxLng && row.lat >= bounds.minLat && row.lat <= bounds.maxLat)
      .filter((row) => pointInPolygon(row.lng, row.lat, filters.polygon));
  }

  const sortBy = filters.sort_by || 'name';
  const dir = (filters.sort_dir || 'asc').toLowerCase() === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    const av = a[sortBy] ?? '';
    const bv = b[sortBy] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });

  const page = Number(filters.page) || 1;
  const limit = Math.min(Number(filters.limit) || 200, 5000);
  return rows.slice((page - 1) * limit, page * limit);
}

async function getById(id) {
  const rows = await list({ limit: 10000 });
  const pharmacy = rows.find((row) => String(row.id) === String(id));
  if (!pharmacy) {
    const err = new Error('Pharmacy not found');
    err.status = 404;
    throw err;
  }
  return pharmacy;
}

module.exports = {
  list,
  getById,
  getSemanticMap,
};
