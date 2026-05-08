require('dotenv').config();

// All app tables live in `marzam_app`. PostGIS extensions stay in `public`.
// Setting searchPath at connection level guarantees both knex query builder and
// raw SQL resolve unqualified names against marzam_app first, then public.
const APP_SEARCH_PATH = ['marzam_app', 'public'];

function buildConnection({ pooled = false } = {}) {
  const url = pooled
    ? (process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL)
    : process.env.DATABASE_URL;
  // Ignore placeholder URLs like postgresql://<user>:<pass>@<IP>:5432/...
  // (we sometimes leave those in .env as a hint when individual DB_* vars
  // are still the source of truth).
  const looksLikePlaceholder = typeof url === 'string' && /[<>]/.test(url);
  if (url && !looksLikePlaceholder) {
    return process.env.NODE_ENV === 'production'
      ? { connectionString: url, ssl: { rejectUnauthorized: false } }
      : { connectionString: url };
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'marzam_mvp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ...(process.env.NODE_ENV === 'production' ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

const migrationsCfg = {
  directory: './migrations',
  // Pin the knex_migrations bookkeeping table inside marzam_app so it doesn't
  // fight with public-schema permissions on this database (ingestion_user has
  // no CREATE in public).
  schemaName: 'marzam_app',
  tableName: 'knex_migrations',
};

module.exports = {
  development: {
    client: 'pg',
    connection: buildConnection({ pooled: true }),
    searchPath: APP_SEARCH_PATH,
    pool: {
      min: Number(process.env.DB_POOL_MIN) || 2,
      max: Number(process.env.DB_POOL_MAX) || 10,
    },
    migrations: migrationsCfg,
    seeds: { directory: './seeds' },
  },

  production: {
    client: 'pg',
    connection: buildConnection({ pooled: true }),
    searchPath: APP_SEARCH_PATH,
    // Vercel runs many serverless instances — pool is per-instance. Keeping max=1
    // creates head-of-line blocking on bursts (manager dashboard + tracking pings
    // simultaneously). max=5 with longer acquire/idle timeouts is the documented
    // sweet spot for pgbouncer transaction-pooling under serverless. See
    // CLAUDE.md "Production state and current constraints".
    pool: {
      min: Number(process.env.DB_POOL_MIN) || 0,
      max: Number(process.env.DB_POOL_MAX) || 5,
      acquireTimeoutMillis: Number(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS) || 8000,
      idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS) || 30000,
      createTimeoutMillis: Number(process.env.DB_POOL_CREATE_TIMEOUT_MS) || 8000,
    },
    migrations: migrationsCfg,
    seeds: { directory: './seeds' },
  },

  // Used by knex CLI for migrations — bypasses the pooler (PgBouncer transaction-mode
  // doesn't support the session features that migrations need).
  migrations: {
    client: 'pg',
    connection: buildConnection({ pooled: false }),
    searchPath: APP_SEARCH_PATH,
    pool: { min: 0, max: 1 },
    migrations: migrationsCfg,
    seeds: { directory: './seeds' },
  },
};
