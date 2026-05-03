#!/usr/bin/env node
/**
 * Schema inspector for the 4 Marzam source tables (in Postgres — see
 * docs/bq-sync.md for why the file is still named with `bq-` prefix).
 *
 * For each table:
 *   1. Pull a few sample rows (LIMIT 5) to discover the actual column names.
 *   2. Cross-check against the COL_CANDIDATES of the corresponding sync job:
 *      - ✓ MAPPED   : at least one candidate present in the table → safe
 *      - ⚠ MISSING  : no candidate matched → that field will always be null
 *      - ? UNKNOWN  : column exists in source but not in any candidate list → opportunity
 *   3. Print one anonymized sample row to spot data shape issues
 *      (e.g. all-null email column, role values not in our role enum, etc.).
 *
 * Run before deploying or after BlackPrint changes a table — this is the
 * fastest way to know whether `npm run bq:dry-run` will produce useful results.
 *
 * Usage:
 *   node scripts/bq-inspect-schemas.js
 *   node scripts/bq-inspect-schemas.js --table cuadro_basico
 *   node scripts/bq-inspect-schemas.js --json   # machine-readable output
 */

require('dotenv').config();

const {
  SOURCE_TABLES,
  fetchAll,
  tableExists,
  describeTable,
  normalizeKey,
} = require('../src/modules/bq-sync/bqHelpers');
const { destroyMarzamSourceDb } = require('../src/integrations/marzamSource/client');

// Read each job's COL_CANDIDATES directly from the job module so the
// inspector never drifts from the actual sync code.
function jobCandidates(modulePath) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const mod = require(modulePath);
  if (typeof mod.__getCandidatesForInspector === 'function') {
    return mod.__getCandidatesForInspector();
  }
  throw new Error(`${modulePath} does not export __getCandidatesForInspector`);
}

const JOBS = {
  cuadro_basico: {
    table: SOURCE_TABLES.CUADRO_BASICO,
    candidates: jobCandidates('../src/modules/bq-sync/jobs/syncCuadroBasico'),
  },
  // The prospect_scored job now reads from the master_scored pair.  We
  // expose both tables under namespaced inspector keys so `npm run
  // bq:inspect master_scored_farmacias` still works field-by-field.
  master_scored_farmacias: {
    table: SOURCE_TABLES.MASTER_SCORED_FARMACIAS,
    candidates: jobCandidates('../src/modules/bq-sync/jobs/syncProspectScored'),
  },
  master_scored_consultorios: {
    table: SOURCE_TABLES.MASTER_SCORED_CONSULTORIOS,
    candidates: jobCandidates('../src/modules/bq-sync/jobs/syncProspectScored'),
  },
  detalle_mostrador: {
    table: SOURCE_TABLES.DETALLE_MOSTRADOR,
    candidates: jobCandidates('../src/modules/bq-sync/jobs/syncDetalleMostrador'),
  },
  clients_ecatepec: {
    table: SOURCE_TABLES.CLIENTS_ECATEPEC,
    candidates: jobCandidates('../src/modules/bq-sync/jobs/syncClientsEcatepec'),
  },
};

function colorize(s, code) {
  if (!process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const ok = (s) => colorize(s, '32');
const warn = (s) => colorize(s, '33');
const err = (s) => colorize(s, '31');
const dim = (s) => colorize(s, '2');
const bold = (s) => colorize(s, '1');

function anonymize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value.value !== undefined) return anonymize(value.value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  if (s.length === 0) return s;
  if (s.length <= 4) return `${s[0]}***`;
  if (/@/.test(s)) {
    const [local, domain] = s.split('@');
    return `${local[0]}***@${domain}`;
  }
  // numeric-looking — show full
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  return `${s.slice(0, 2)}***${s.slice(-2)} (len=${s.length})`;
}

function inspectJob(jobName, sampleRows, columnsMeta) {
  const job = JOBS[jobName];
  const present = new Set();
  const presentNorm = new Map();
  const sources = sampleRows.length ? sampleRows : columnsMeta.map((c) => ({ [c.column_name]: null }));
  for (const r of sources) {
    for (const k of Object.keys(r)) {
      present.add(k);
      presentNorm.set(normalizeKey(k), k);
    }
  }
  const totalCols = present.size;
  const usedRawCols = new Set();
  const result = { table: job.table, total_columns: totalCols, fields: {}, unknown_columns: [] };

  for (const [field, candidates] of Object.entries(job.candidates || {})) {
    const matched = [];
    for (const c of candidates) {
      const real = presentNorm.get(normalizeKey(c));
      if (real) {
        matched.push(real);
        usedRawCols.add(real);
      }
    }
    result.fields[field] = {
      status: matched.length ? 'mapped' : 'missing',
      matched,
      candidates,
    };
  }

  result.unknown_columns = Array.from(present).filter((c) => !usedRawCols.has(c)).sort();
  return result;
}

function printJobReport(jobName, report, sampleRows, columnsMeta) {
  console.log(`\n${bold('═'.repeat(78))}`);
  console.log(bold(`Job: ${jobName}   Table: ${report.table}`));
  console.log(bold('═'.repeat(78)));
  console.log(`  Sample rows: ${sampleRows.length}    Total columns: ${report.total_columns}\n`);

  const mapped = Object.entries(report.fields).filter(([, v]) => v.status === 'mapped');
  const missing = Object.entries(report.fields).filter(([, v]) => v.status === 'missing');

  console.log(`${ok('MAPPED')} (${mapped.length}/${Object.keys(report.fields).length})`);
  for (const [field, info] of mapped) {
    console.log(`  ${ok('✓')} ${field.padEnd(28)} → ${info.matched.join(', ')}`);
  }

  if (missing.length) {
    console.log(`\n${warn('MISSING')} (${missing.length}) — these will always be null in the sync output`);
    for (const [field, info] of missing) {
      console.log(`  ${warn('⚠')} ${field.padEnd(28)} ${dim(`(tried: ${info.candidates.join(', ')})`)}`);
    }
  }

  if (report.unknown_columns.length) {
    console.log(`\n${dim('UNKNOWN SOURCE COLUMNS')} (${report.unknown_columns.length}) — present in Postgres but not in any candidate list`);
    const dataTypeByName = new Map(columnsMeta.map((c) => [c.column_name, c.data_type]));
    for (const c of report.unknown_columns) {
      const dt = dataTypeByName.get(c);
      console.log(`  ${dim('?')} ${c}${dt ? dim(` :: ${dt}`) : ''}`);
    }
  }

  if (sampleRows.length) {
    console.log(`\n${dim('SAMPLE row 1 (anonymized):')}`);
    const first = sampleRows[0];
    for (const k of Object.keys(first).sort()) {
      const v = anonymize(first[k]);
      console.log(`  ${k.padEnd(36)} = ${v === null ? dim('NULL') : JSON.stringify(v)}`);
    }
  }
}

function parseArgs(argv) {
  const args = { table: null, json: false, limit: 5 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--table') { args.table = next; i += 1; }
    else if (a === '--json') args.json = true;
    else if (a === '--limit') { args.limit = Number(next); i += 1; }
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/bq-inspect-schemas.js [--table NAME] [--limit N] [--json]
  --table   ${Object.keys(JOBS).join(' | ')}    (default: all)
  --limit   sample rows fetched per table         (default: 5)
  --json    machine-readable output`);
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const targetJobs = args.table ? [args.table] : Object.keys(JOBS);
  if (args.table && !JOBS[args.table]) {
    console.error(err(`Unknown job '${args.table}'. Choices: ${Object.keys(JOBS).join(', ')}`));
    process.exit(1);
  }

  const allReports = [];
  for (const jobName of targetJobs) {
    const job = JOBS[jobName];
    if (!args.json) console.log(dim(`Querying ${job.table} (LIMIT ${args.limit})...`));
    let sampleRows;
    let columnsMeta;
    try {
      const exists = await tableExists(job.table);
      if (!exists) throw new Error(`table '${job.table}' not found in source DB`);
      [sampleRows, columnsMeta] = await Promise.all([
        fetchAll(job.table, { limit: args.limit }),
        describeTable(job.table),
      ]);
    } catch (e) {
      const report = { table: job.table, error: e.message };
      allReports.push({ job: jobName, ...report });
      if (!args.json) console.log(`\n${err(`✗ ${jobName} — query failed: ${e.message}`)}`);
      continue;
    }
    const report = inspectJob(jobName, sampleRows, columnsMeta);
    allReports.push({ job: jobName, ...report });
    if (!args.json) printJobReport(jobName, report, sampleRows, columnsMeta);
  }

  if (!args.json) {
    console.log(`\n${bold('═'.repeat(78))}\n${bold('SUMMARY')}\n${bold('═'.repeat(78))}`);
    for (const r of allReports) {
      if (r.error) {
        console.log(`  ${err('✗')} ${r.job.padEnd(20)} ${err(r.error)}`);
        continue;
      }
      const mapped = Object.values(r.fields).filter((f) => f.status === 'mapped').length;
      const total = Object.keys(r.fields).length;
      const symbol = mapped === total ? ok('✓') : (mapped > total / 2 ? warn('~') : err('✗'));
      console.log(`  ${symbol} ${r.job.padEnd(20)} ${mapped}/${total} fields mapped, ${r.unknown_columns.length} unknown source columns`);
    }
  } else {
    console.log(JSON.stringify(allReports, null, 2));
  }

  await destroyMarzamSourceDb();
  const anyError = allReports.some((r) => r.error);
  process.exit(anyError ? 1 : 0);
}

main().catch((e) => {
  console.error(err(`Fatal: ${e.stack || e.message}`));
  destroyMarzamSourceDb().finally(() => process.exit(1));
});
