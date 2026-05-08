const db = require('../../config/database');
const { isExternalDataMode } = require('../../repositories/runtime');
const { createCache } = require('../../utils/memoryCache');

const cache = createCache({
  ttlSeconds: Number(process.env.CACHE_TTL_COLONIAS_SECONDS) || 120,
  maxEntries: 100,
});

function invalidate() {
  cache.clear();
}

function cacheKey(filters) {
  return JSON.stringify({
    m: filters.municipality || null,
    s: filters.security_level || null,
    q: filters.search || null,
    bb: filters.bbox || null,
    l: Math.min(Number(filters.limit) || 2000, 5000),
  });
}

async function list(filters = {}) {
  if (isExternalDataMode()) return [];
  return cache.wrap(`list:${cacheKey(filters)}`, () => listFromDb(filters));
}

async function listFromDb(filters = {}) {
  const q = db('colonias')
    .select(
      'id',
      'objectid',
      'postalcode',
      'state_name',
      'municipality_name',
      'settlement_name',
      'settlement_type',
      'security_level',
      'area_m2',
      'updated_at',
      db.raw(`ST_AsGeoJSON(geom)::json AS geojson`),
      db.raw(`ST_X(ST_Centroid(geom)) AS centroid_lng`),
      db.raw(`ST_Y(ST_Centroid(geom)) AS centroid_lat`),
    );

  if (filters.municipality) q.where('municipality_name', filters.municipality);
  if (filters.security_level) q.where('security_level', filters.security_level);
  if (filters.search) {
    q.where(function () {
      this.whereILike('settlement_name', `%${filters.search}%`)
        .orWhereILike('settlement_type', `%${filters.search}%`);
    });
  }
  if (filters.bbox) {
    const [west, south, east, north] = filters.bbox;
    q.whereRaw(`geom && ST_MakeEnvelope(?, ?, ?, ?, 4326)`, [west, south, east, north]);
  }

  q.orderBy('settlement_name', 'asc');

  const limit = Math.min(Number(filters.limit) || 2000, 5000);
  q.limit(limit);

  return q;
}

async function getById(id) {
  if (isExternalDataMode()) {
    const err = new Error('Colonia not found');
    err.status = 404;
    throw err;
  }
  const colonia = await db('colonias')
    .select(
      '*',
      db.raw(`ST_AsGeoJSON(geom)::json AS geojson`),
    )
    .where({ id })
    .first();
  if (!colonia) {
    const err = new Error('Colonia not found');
    err.status = 404;
    throw err;
  }
  return colonia;
}

async function updateSecurityLevel(id, { security_level, updated_by }) {
  const valid = ['acceptable', 'caution', 'not_acceptable'];
  if (!valid.includes(security_level)) {
    const err = new Error(`security_level must be one of: ${valid.join(', ')}`);
    err.status = 422;
    throw err;
  }
  if (isExternalDataMode()) {
    const err = new Error('Colonia security updates are not available in external data mode');
    err.status = 501;
    throw err;
  }

  const before = await getById(id);
  const [updated] = await db('colonias')
    .where({ id })
    .update({ security_level, updated_by, updated_at: db.fn.now() })
    .returning('*');

  invalidate();
  return { before, after: updated };
}

async function batchUpdateSecurityLevel(ids, { security_level, updated_by }) {
  const valid = ['acceptable', 'caution', 'not_acceptable'];
  if (!valid.includes(security_level)) {
    const err = new Error(`security_level must be one of: ${valid.join(', ')}`);
    err.status = 422;
    throw err;
  }
  if (isExternalDataMode()) {
    const err = new Error('Colonia security updates are not available in external data mode');
    err.status = 501;
    throw err;
  }

  const count = await db('colonias')
    .whereIn('id', ids)
    .update({ security_level, updated_by, updated_at: db.fn.now() });

  invalidate();
  return { updated: count };
}

async function listAsGeoJSON(filters = {}) {
  const rows = await list(filters);
  return {
    type: 'FeatureCollection',
    features: rows
      .filter((r) => r.geojson)
      .map((r) => ({
        type: 'Feature',
        geometry: r.geojson,
        properties: {
          id: r.id,
          settlement_name: r.settlement_name,
          settlement_type: r.settlement_type,
          security_level: r.security_level,
          municipality_name: r.municipality_name,
          postalcode: r.postalcode,
        },
      })),
  };
}

async function getExcludedColoniaIds() {
  if (isExternalDataMode()) return [];
  const rows = await db('colonias')
    .select('id')
    .where('security_level', 'not_acceptable');
  return rows.map((r) => r.id);
}

module.exports = {
  list,
  getById,
  updateSecurityLevel,
  batchUpdateSecurityLevel,
  listAsGeoJSON,
  getExcludedColoniaIds,
};
