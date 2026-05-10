/**
 * Per-branch plan settings — cutoff, working_days, timezone, route window.
 *
 * Hot path: planGenerator + planEngine.resolveWindow read this on every plan
 * generate. Cached in-memory for 60s, invalidated on settings update.
 *
 * Shape (validated on read):
 *   {
 *     cutoff_hhmm: string,         // 'HH:MM' (24h), e.g. '08:30'
 *     working_days: int[],          // JS getDay convention. 0=Sun..6=Sat.
 *                                   // Default [0,1,2,3,4,5] = Dom-Vie (sábado excluido).
 *     timezone: string,             // IANA tz, defaults 'America/Mexico_City'
 *     expected_route_start: string, // 'HH:MM'
 *     expected_route_end: string,   // 'HH:MM'
 *   }
 */

const db = require('../config/database');

const DEFAULTS = Object.freeze({
  cutoff_hhmm: '08:30',
  working_days: [0, 1, 2, 3, 4, 5],
  timezone: 'America/Mexico_City',
  expected_route_start: '08:00',
  expected_route_end: '17:00',
});

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const TTL_MS = 60_000;
const cache = new Map(); // branchId → { value, expiresAt }

function validate(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;

  if (typeof raw.cutoff_hhmm === 'string' && HHMM_RE.test(raw.cutoff_hhmm)) {
    out.cutoff_hhmm = raw.cutoff_hhmm;
  }
  if (Array.isArray(raw.working_days)) {
    const wd = raw.working_days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (wd.length > 0) out.working_days = [...new Set(wd)].sort((a, b) => a - b);
  }
  if (typeof raw.timezone === 'string' && raw.timezone.length > 0) {
    out.timezone = raw.timezone;
  }
  if (typeof raw.expected_route_start === 'string' && HHMM_RE.test(raw.expected_route_start)) {
    out.expected_route_start = raw.expected_route_start;
  }
  if (typeof raw.expected_route_end === 'string' && HHMM_RE.test(raw.expected_route_end)) {
    out.expected_route_end = raw.expected_route_end;
  }
  return out;
}

/**
 * Return validated plan settings for a branch. Falls back to DEFAULTS if the
 * branch has no row or no plan_settings column populated.
 */
async function get(branchId) {
  if (!branchId) return { ...DEFAULTS };
  const cached = cache.get(branchId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let row = null;
  try {
    row = await db('branches').select('plan_settings').where({ id: branchId }).first();
  } catch (_) {
    return { ...DEFAULTS };
  }
  const value = validate(row?.plan_settings || null);
  cache.set(branchId, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/**
 * Update settings for a branch. Persists JSONB and evicts cache.
 */
async function update(branchId, patch) {
  if (!branchId) throw new Error('branchId required');
  const current = await get(branchId);
  const merged = validate({ ...current, ...patch });
  await db('branches')
    .where({ id: branchId })
    .update({ plan_settings: merged, updated_at: db.fn.now() });
  cache.delete(branchId);
  return merged;
}

/** Force cache eviction (e.g. after a direct SQL update from another service). */
function evict(branchId) {
  if (branchId) cache.delete(branchId);
  else cache.clear();
}

module.exports = {
  DEFAULTS,
  get,
  update,
  evict,
  __validate: validate, // exported for tests
};
