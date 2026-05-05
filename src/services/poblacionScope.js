/**
 * Filtro global por `zona_poblaciones` (en `employee_profiles`).
 *
 * IMPORTANTE — comportamiento actualizado (2026-04-29):
 *
 * El sistema YA NO fuerza "Estado de México" como población activa por
 * defecto. El comportamiento es:
 *
 *   - Los roles de management (director, gerente, supervisor) NO se
 *     filtran por población salvo que el caller pase `?poblacion=...`
 *     en la query. Esto significa que ven TODA la información que el
 *     RBAC les permite (toda la sucursal / gerencia / supervisión).
 *
 *   - El endpoint `/api/poblaciones` devuelve TODAS las poblaciones
 *     conocidas como `enabled: true`, para que la UI pueda elegir
 *     cualquiera como filtro voluntario.
 *
 *   - Si la env `MARZAM_ACTIVE_POBLACION` está seteada, sirve solo
 *     como sugerencia de UI (la opción que aparece pre-seleccionada en
 *     el dropdown). No se aplica como filtro forzado.
 *
 * Si en el futuro se necesita volver a un piloto cerrado a una sola
 * zona, basta con setear `MARZAM_RESTRICT_POBLACION=1` y la lista de
 * habilitadas vuelve a ser solo `MARZAM_ACTIVE_POBLACION`.
 */

const db = require('../config/database');
const { efKey } = require('../utils/efKey');

const DEFAULT_ACTIVE = 'Estado de México';

function getActivePoblacion() {
  // Sigue exponiendo la sugerencia de UI; no es un filtro hard.
  return (process.env.MARZAM_ACTIVE_POBLACION || DEFAULT_ACTIVE).trim();
}

function isRestrictedToActive() {
  return process.env.MARZAM_RESTRICT_POBLACION === '1'
    || process.env.MARZAM_RESTRICT_POBLACION === 'true';
}

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

async function listKnownPoblaciones() {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < CACHE_TTL_MS) return _cache;
  // PRIMARY source: marzam_clients.poblacion — la columna real que enlaza
  // farmacias con su Entidad Federativa. Es el dato canónico que el usuario
  // pidió usar (no `employee_profiles.zona_poblaciones`, que era una
  // descripción libre del rep y no un join).
  let primary = [];
  try {
    const rows = await db('marzam_clients')
      .whereNotNull('poblacion')
      .where('poblacion', '<>', '')
      .distinct('poblacion')
      .orderBy('poblacion', 'asc');
    primary = rows.map((r) => r.poblacion).filter(Boolean);
  } catch {
    primary = [];
  }
  // FALLBACK: si por alguna razón marzam_clients no tiene registros aún,
  // mantenemos la lista vieja como red de seguridad para que el dropdown
  // no aparezca vacío.
  if (!primary.length) {
    try {
      const rows = await db('employee_profiles')
        .whereNotNull('zona_poblaciones')
        .where('zona_poblaciones', '<>', '')
        .distinct('zona_poblaciones')
        .orderBy('zona_poblaciones', 'asc');
      primary = rows.map((r) => r.zona_poblaciones).filter(Boolean);
    } catch {
      primary = [];
    }
  }
  _cache = primary;
  _cacheAt = now;
  return _cache;
}

/**
 * Resuelve la población activa para una request. Retorna `null` si no
 * se pide ninguna explícitamente (= sin filtro). Solo retorna un valor
 * si el usuario lo pidió explícitamente y existe en la lista conocida.
 *
 * Supports alias normalization (e.g. "edomex" → "Estado de México") via
 * efKey comparison so that URL params like ?poblacion=edomex work correctly.
 */
async function resolveActiveFromQuery(req) {
  const requested = (req?.query?.poblacion || '').toString().trim();
  if (!requested || requested === 'all' || requested === 'todas' || requested === '__all__') {
    return null; // sin filtro
  }
  const known = await listKnownPoblaciones();
  // 1. Exact match first (fast path, no normalization cost)
  if (known.includes(requested)) return requested;
  // 2. Normalized match — "edomex", "cdmx", etc. resolve to canonical
  const keyedRaw = efKey(requested);
  const match = known.find((k) => efKey(k) === keyedRaw);
  if (match) return match;
  // If restricted mode and no match found, fall back to active default
  if (isRestrictedToActive()) return getActivePoblacion();
  return null; // valor inválido → no filtrar (no falla)
}

/**
 * Devuelve un array de user_ids que sirven a la Entidad Federativa
 * (poblacion) indicada — derivado de las asignaciones reales en
 * `marzam_clients`. Un user "pertenece" a una población si tiene al menos
 * un cliente asignado (rep / supervisor / gerente) cuya `poblacion`
 * coincida.
 *
 * The `poblacion` argument is normalized via efKey before the lookup so
 * that aliases like "edomex" resolve to the canonical "Estado de México".
 */
async function userIdsInPoblacion(poblacion) {
  if (!poblacion) return [];
  try {
    // Resolve alias → canonical DB value (e.g. "edomex" → "Estado de México")
    const known = await listKnownPoblaciones();
    const keyedRaw = efKey(poblacion);
    const canonical = known.find((k) => efKey(k) === keyedRaw) || poblacion;

    const rows = await db.raw(`
      SELECT DISTINCT user_id FROM (
        SELECT assigned_rep_id        AS user_id FROM marzam_clients WHERE poblacion = ? AND assigned_rep_id        IS NOT NULL
        UNION ALL
        SELECT assigned_supervisor_id AS user_id FROM marzam_clients WHERE poblacion = ? AND assigned_supervisor_id IS NOT NULL
        UNION ALL
        SELECT assigned_gerente_id    AS user_id FROM marzam_clients WHERE poblacion = ? AND assigned_gerente_id    IS NOT NULL
      ) t
      WHERE user_id IS NOT NULL
    `, [canonical, canonical, canonical]);
    return (rows.rows || []).map((r) => r.user_id).filter(Boolean);
  } catch {
    return [];
  }
}

function clearCache() { _cache = null; _cacheAt = 0; }

module.exports = {
  DEFAULT_ACTIVE,
  getActivePoblacion,
  isRestrictedToActive,
  listKnownPoblaciones,
  resolveActiveFromQuery,
  userIdsInPoblacion,
  clearCache,
};
