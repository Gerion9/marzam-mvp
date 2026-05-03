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
  try {
    const rows = await db('employee_profiles')
      .whereNotNull('zona_poblaciones')
      .where('zona_poblaciones', '<>', '')
      .distinct('zona_poblaciones')
      .orderBy('zona_poblaciones', 'asc');
    _cache = rows.map((r) => r.zona_poblaciones).filter(Boolean);
  } catch {
    // Tabla no existe (modo external/demo) — devolvemos lista mínima.
    _cache = [];
  }
  _cacheAt = now;
  return _cache;
}

/**
 * Resuelve la población activa para una request. Retorna `null` si no
 * se pide ninguna explícitamente (= sin filtro). Solo retorna un valor
 * si el usuario lo pidió explícitamente y existe en la lista conocida.
 */
async function resolveActiveFromQuery(req) {
  const requested = (req?.query?.poblacion || '').toString().trim();
  if (!requested || requested === 'all' || requested === 'todas' || requested === '__all__') {
    return null; // sin filtro
  }
  const known = await listKnownPoblaciones();
  if (known.includes(requested)) return requested;
  // Si está en modo restringido y la pedida no es la activa, fuerza activa.
  if (isRestrictedToActive()) return getActivePoblacion();
  return null; // valor inválido → no filtrar (no falla)
}

/**
 * Devuelve un array de user_ids que pertenecen a la zona activa.
 * Útil para filtrar pharmacies/team/visits por usuarios de esa zona.
 */
async function userIdsInPoblacion(poblacion) {
  if (!poblacion) return [];
  try {
    const rows = await db('employee_profiles')
      .where('zona_poblaciones', poblacion)
      .pluck('user_id');
    return rows.filter(Boolean);
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
