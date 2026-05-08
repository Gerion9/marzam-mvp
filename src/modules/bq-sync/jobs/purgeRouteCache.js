/**
 * Cron job: purge route_matrix_cache entries older than 23 days.
 *
 * The Routes API ToS forbids retaining derived lat/lng data longer than 30
 * calendar days. We keep the on-disk row for 23 days (giving a 7-day buffer)
 * and refresh on demand via routesMatrix.computeMatrixCached.
 *
 * Wired to /api/admin/bq-sync/_purge-route-cache via vercel.json (daily).
 */

const routesMatrix = require('../../../services/routesMatrix');

async function run() {
  const result = await routesMatrix.purgeExpired();
  return {
    job: 'purge_route_cache',
    deleted: result.deleted,
  };
}

module.exports = { run };
