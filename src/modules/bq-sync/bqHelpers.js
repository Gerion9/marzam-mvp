/**
 * Tolerant source helpers used by the four sync jobs.
 *
 * History: the source was originally going to be BigQuery; tables turned out
 * to live in Postgres (same instance as the app, different schemas — see
 * docs/bq-sync.md for the why). We kept the module/file names with the
 * `bq` prefix to avoid churn in the cron path (`/api/admin/bq-sync/_worker`)
 * and the public scripts (`npm run bq:inspect`), but everything below
 * actually talks to Postgres.
 *
 * The ETL jobs MUST keep working even if BlackPrint renames a column or adds
 * a new one we don't know about. So we:
 *   1) read with `SELECT *` (don't enumerate columns at query time),
 *   2) translate raw rows into our shape with `pickFirst([...candidates])`,
 *   3) emit a soft warning when an expected column is missing.
 *
 * Confirmed column names should land in docs/bq-sync.md as findings; the
 * candidate arrays in each job file are the working assumption.
 */

const { getMarzamSourceDb } = require('../../integrations/marzamSource/client');

// schema.table references in the source Postgres (database = blackprint_db_prd).
// Override per-table with env vars to point to alternate schemas.
const SOURCE_TABLES = {
  CUADRO_BASICO: process.env.MARZAM_SOURCE_TABLE_CUADRO_BASICO
    || process.env.BQ_TABLE_CUADRO_BASICO
    || 'integration.int_marzam_cuadro_basico',
  PROSPECT_SCORED: process.env.MARZAM_SOURCE_TABLE_PROSPECT_SCORED
    || process.env.BQ_TABLE_PROSPECT_SCORED
    || 'integration.int_marzam_prospect_scored',
  DETALLE_MOSTRADOR: process.env.MARZAM_SOURCE_TABLE_DETALLE_MOSTRADOR
    || process.env.BQ_TABLE_DETALLE_MOSTRADOR
    || 'staging.stg_marzam_detalle_mostrador',
  CLIENTS_ECATEPEC: process.env.MARZAM_SOURCE_TABLE_CLIENTS_ECATEPEC
    || process.env.BQ_TABLE_CLIENTS_ECATEPEC
    || 'staging.stg_marzam_clients_ecatepec',
  // Master-scored pair shipped 2026-04 — same 98-column schema, different
  // contents.  Used by syncProspectScored as the source of the unified
  // pharmacies/consultorios universe.  The 202 CLIENT rows are duplicated
  // across both tables; dedup is by `dataplor_id`.
  MASTER_SCORED_FARMACIAS: process.env.MARZAM_SOURCE_TABLE_MASTER_SCORED_FARMACIAS
    || 'staging.stg_marzam_master_scored_farmacias',
  MASTER_SCORED_CONSULTORIOS: process.env.MARZAM_SOURCE_TABLE_MASTER_SCORED_CONSULTORIOS
    || 'staging.stg_marzam_master_scored_consultorios',
};
// Backwards-compatible alias (some tests/scripts import BQ_TABLES).
const BQ_TABLES = SOURCE_TABLES;

/**
 * Strip an optional database prefix and split into [schema, table].
 *   "blackprint_db_prd.staging.foo" → ["staging", "foo"]
 *   "staging.foo"                   → ["staging", "foo"]
 *   "foo"                           → ["public", "foo"]   (defensive default)
 */
function splitTable(fqn) {
  if (!fqn) throw new Error('splitTable requires a non-empty table reference');
  const parts = String(fqn).split('.').map((p) => p.replace(/^"(.+)"$/, '$1'));
  if (parts.length === 1) return ['public', parts[0]];
  if (parts.length === 2) return [parts[0], parts[1]];
  return [parts[parts.length - 2], parts[parts.length - 1]];
}

/**
 * Fetch all rows from a source table (or LIMIT N for sampling).
 *
 * Returns plain objects with the ORIGINAL column names from Postgres
 * (snake_case as stored by the data team). The caller normalizes via
 * `pickFirst([...candidates])` to tolerate renames.
 */
async function fetchAll(tableRef, { limit = null } = {}) {
  const [schema, table] = splitTable(tableRef);
  const db = getMarzamSourceDb();
  const builder = db.withSchema(schema).from(table).select('*');
  if (limit !== null && limit !== undefined) {
    builder.limit(Math.trunc(Number(limit)));
  }
  return builder;
}

/**
 * Cheap existence check used by the inspector before pulling sample rows —
 * lets us produce a friendlier error than "relation does not exist".
 */
async function tableExists(tableRef) {
  const [schema, table] = splitTable(tableRef);
  const db = getMarzamSourceDb();
  const { rows } = await db.raw(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = ? AND table_name = ?
      LIMIT 1`,
    [schema, table],
  );
  return rows.length > 0;
}

/**
 * Read information_schema.columns for a table — used by the inspector to
 * report data types alongside the column names.
 */
async function describeTable(tableRef) {
  const [schema, table] = splitTable(tableRef);
  const db = getMarzamSourceDb();
  const { rows } = await db.raw(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?
      ORDER BY ordinal_position`,
    [schema, table],
  );
  return rows;
}

function normalizeKey(key) {
  return String(key || '')
    .normalize('NFD')
    // strip combining diacritics
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildKeyMap(row) {
  const map = new Map();
  for (const k of Object.keys(row)) {
    map.set(normalizeKey(k), k);
  }
  return map;
}

function pickFirst(row, candidates, keyMap = null) {
  const map = keyMap || buildKeyMap(row);
  for (const c of candidates) {
    const key = map.get(normalizeKey(c));
    if (key !== undefined && row[key] !== null && row[key] !== undefined && row[key] !== '') {
      return row[key];
    }
  }
  return null;
}

function asString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value.value !== undefined) {
    return String(value.value).trim() || null;
  }
  const s = String(value).trim();
  return s === '' ? null : s;
}

function asInt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && value.value !== undefined) value = value.value;
  const cleaned = String(value).replace(/[^\d.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && value.value !== undefined) value = value.value;
  const cleaned = String(value).replace(/[^\d.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function asBool(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'si', 'sí', 'yes', 'y', 'x', 't'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'f'].includes(s)) return false;
  return null;
}

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object' && value.value) value = value.value;
  const s = String(value).trim();
  const ymd = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
  if (ymd) {
    const [, y, m, d = '01'] = ymd;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // DMY (Mexican)
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

function logMissingColumn(jobName, expected, presentKeys) {
  // eslint-disable-next-line no-console
  console.warn(`[marzam-sync:${jobName}] expected column "${expected}" not found. Available: ${presentKeys.slice(0, 30).join(', ')}`);
}

/**
 * Detect schema drift in a source table by checking, before the per-row loop,
 * that each logical field in `candidatesByLogicalName` has at least ONE
 * candidate column present in the row's `keyMap`. Source schema is uniform
 * across rows of a single fetch, so this is a once-per-job check — much less
 * noisy than calling logMissingColumn after every pickFirst().
 *
 * Logs a warning for every logical name that's MISSING and listed in
 * `requiredLogicalNames`. Optional fields are still reported in the return
 * value (so the job can surface them) but don't trigger a console warning.
 *
 * @returns {{ missing: string[], missing_required: string[] }}
 */
function auditCandidateColumns(jobName, keyMap, candidatesByLogicalName, requiredLogicalNames = []) {
  const missing = [];
  const required = new Set(requiredLogicalNames);
  for (const [logicalName, candidates] of Object.entries(candidatesByLogicalName)) {
    const found = candidates.some((c) => keyMap.has(normalizeKey(c)));
    if (!found) {
      missing.push(logicalName);
      if (required.has(logicalName)) {
        logMissingColumn(jobName, candidates.join('/'), [...keyMap.keys()]);
      }
    }
  }
  return {
    missing,
    missing_required: missing.filter((n) => required.has(n)),
  };
}

/**
 * Coerce `stats` into a final job status. The doc's heuristic: if the job
 * accumulated more than `threshold * rows` warnings, the run is unhealthy
 * enough to mark as `failed` (visible in cron_runs) so an oncall human can
 * investigate. Returns `{ status, reason }`.
 */
function evaluateJobHealth(stats, { warningThreshold = 0.5 } = {}) {
  const rows = Number(stats?.rows) || 0;
  const warnings = Number(stats?.warnings) || 0;
  if (rows === 0) {
    return { status: 'ok', reason: null };
  }
  const ratio = warnings / rows;
  if (ratio > warningThreshold) {
    return {
      status: 'failed',
      reason: `warnings_ratio=${ratio.toFixed(2)} exceeds threshold=${warningThreshold}`,
    };
  }
  return { status: 'ok', reason: null };
}

module.exports = {
  SOURCE_TABLES,
  // back-compat
  BQ_TABLES,
  fetchAll,
  tableExists,
  describeTable,
  splitTable,
  normalizeKey,
  buildKeyMap,
  pickFirst,
  asString,
  asInt,
  asNumeric,
  asBool,
  asDate,
  logMissingColumn,
  auditCandidateColumns,
  evaluateJobHealth,
};
