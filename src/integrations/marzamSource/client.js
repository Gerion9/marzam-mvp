/**
 * Read-only Postgres client for the Marzam **source-of-truth** tables that
 * live alongside our app DB but in different schemas (`staging`, `integration`,
 * `data_product`).
 *
 * Why a separate client and not just `db`?
 *   - The app connects with `ingestion_user`, which has grants on `public`
 *     and `ingestion` only. That user CANNOT see `staging.*` or
 *     `integration.*` (verified 2026-04-29).
 *   - The source tables are owned by the BlackPrint data team and shared
 *     with us through `josue_user` (read-only).
 *   - Keeping the source client separate makes intent obvious — anything
 *     that uses `getMarzamSourceDb()` is a sync job reading external data,
 *     never the app's own state.
 *
 * Connection reuse: knex pool is created lazily on first call and shared
 * for the lifetime of the process (Vercel function instance). Pool sized
 * small because all sync jobs are sequential.
 */

const knex = require('knex');

let client = null;

function buildConfig() {
  const host = process.env.MARZAM_SOURCE_DB_HOST
    || process.env.DB_HOST;
  const port = Number(process.env.MARZAM_SOURCE_DB_PORT
    || process.env.DB_PORT) || 5432;
  const database = process.env.MARZAM_SOURCE_DB_NAME
    || process.env.DB_NAME;
  // Note env var names: OTHER_*_BQ is a misnomer kept from the original
  // .env file — these are Postgres credentials, not BigQuery.
  const user = process.env.MARZAM_SOURCE_DB_USER
    || process.env.OTHER_USER_BQ;
  const password = process.env.MARZAM_SOURCE_DB_PASSWORD
    || process.env.OTHER_PASSWORD_BQ;
  const ssl = (process.env.MARZAM_SOURCE_DB_SSL || '').toLowerCase() === 'true';

  if (!host || !user || !password || !database) {
    const missing = [
      ['host', host], ['database', database], ['user', user], ['password', password],
    ].filter(([, v]) => !v).map(([k]) => k);
    const err = new Error(
      `Marzam source DB is not configured. Missing: ${missing.join(', ')}. `
      + 'Set MARZAM_SOURCE_DB_* (or use the legacy OTHER_USER_BQ/OTHER_PASSWORD_BQ '
      + 'plus DB_HOST/DB_NAME).',
    );
    err.status = 500;
    throw err;
  }

  return {
    client: 'pg',
    connection: {
      host,
      port,
      database,
      user,
      password,
      ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    },
    pool: { min: 0, max: 2, idleTimeoutMillis: 5000 },
    // Source is read-only — fail fast on accidental writes.
    asyncStackTraces: false,
  };
}

function getMarzamSourceDb() {
  if (client) return client;
  client = knex(buildConfig());
  return client;
}

async function destroyMarzamSourceDb() {
  if (client) {
    await client.destroy();
    client = null;
  }
}

module.exports = { getMarzamSourceDb, destroyMarzamSourceDb };
