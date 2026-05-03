#!/usr/bin/env node
/**
 * BQ-sync dry-run.
 *
 * Same code path as the production cron (each job runs against BQ + Postgres),
 * but every job runs inside a single transaction that gets ROLLBACK'd at the
 * end. Lets you preview what the next real sync will do without persisting.
 *
 * Usage:
 *   node scripts/bq-sync-dry-run.js                       # all jobs, full sync (no row limit)
 *   node scripts/bq-sync-dry-run.js --job cuadro_basico   # only one
 *   node scripts/bq-sync-dry-run.js --limit 50            # quick sample for testing
 *   node scripts/bq-sync-dry-run.js --commit              # ⚠ actually persist (no rollback)
 *
 * Default behaviour (2026-04-30): full sync, no row limit. Pass `--limit N` when
 * you only want a sample (e.g. while iterating on the column-mapping logic).
 *
 * Each job is patched at runtime to use a shared knex transaction trx and to
 * skip its own internal trx. We monkey-patch by replacing the `db` import
 * with the trx — that's why the jobs need to all use one `db` symbol from
 * `../../config/database`. (They do — see jobs/*.js).
 */

require('dotenv').config();

const Module = require('module');
const path = require('path');
const realDb = require('../src/config/database');

const JOB_NAMES = ['cuadro_basico', 'prospect_scored', 'detalle_mostrador', 'clients_ecatepec'];

function colorize(s, code) {
  if (!process.stdout.isTTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const ok = (s) => colorize(s, '32');
const warn = (s) => colorize(s, '33');
const err = (s) => colorize(s, '31');
const dim = (s) => colorize(s, '2');
const bold = (s) => colorize(s, '1');

function parseArgs(argv) {
  // limit: null = no row cap (full sync). Pass --limit N for sampling only.
  const args = { job: null, limit: null, commit: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--job') { args.job = next; i += 1; }
    else if (a === '--limit') { args.limit = Number(next); i += 1; }
    else if (a === '--commit') args.commit = true;
    else if (a === '-h' || a === '--help') {
      console.log(`Usage: node scripts/bq-sync-dry-run.js [JOB] [--job NAME] [--limit N] [--commit]
  JOB       positional shortcut: ${JOB_NAMES.join(' | ')}
  --job     same as positional, with explicit flag
  --limit   cap rows fetched per job              (default: no limit — full sync)
  --commit  actually persist (skip rollback)      (DANGEROUS — only for production runs)`);
      process.exit(0);
    }
    // Positional: anything that isn't a flag and matches a known job name.
    // Lets `npm run bq:sync prospect_scored` work without the user having
    // to discover `-- --job` (npm strips bare positionals after the script
    // name, so they reach us as plain argv).
    else if (!a.startsWith('-') && JOB_NAMES.includes(a)) {
      args.job = a;
    }
  }
  return args;
}

/**
 * Replace the resolved cache entry for `src/config/database` so every
 * `require('../../config/database')` inside the jobs returns our trx.
 * Restored after the dry-run finishes.
 */
function patchDbModule(trx) {
  const dbPath = require.resolve(path.join(__dirname, '..', 'src', 'config', 'database'));
  const cached = require.cache[dbPath];
  if (!cached) {
    throw new Error(`Could not locate cached module: ${dbPath}`);
  }
  const original = cached.exports;
  cached.exports = trx;
  return () => {
    cached.exports = original;
  };
}

async function runJob(jobName, trx, limit) {
  // Re-require to get the cached module's reference to our patched db
  // eslint-disable-next-line global-require
  delete require.cache[require.resolve(`../src/modules/bq-sync/jobs/sync${
    jobName.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('')
  }.js`)];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const job = require(`../src/modules/bq-sync/jobs/sync${
    jobName.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('')
  }.js`);
  return job.run({ limit });
}

async function main() {
  const args = parseArgs(process.argv);
  const jobs = args.job ? [args.job] : JOB_NAMES;
  for (const j of jobs) {
    if (!JOB_NAMES.includes(j)) {
      console.error(err(`Unknown job '${j}'. Choices: ${JOB_NAMES.join(', ')}`));
      process.exit(1);
    }
  }

  const banner = args.commit
    ? `${err.bind ? err('⚠ COMMIT MODE — changes will persist!') : '⚠ COMMIT MODE'}`
    : `${dim('🛡  DRY-RUN — transaction will be rolled back')}`;
  console.log(`${bold('BQ Sync Dry-Run')}`);
  console.log(banner);
  const limitLabel = args.limit === null || args.limit === undefined ? 'none (full sync)' : args.limit;
  console.log(`${dim(`Jobs: ${jobs.join(', ')}    Limit per job: ${limitLabel}`)}\n`);

  const startedAt = Date.now();
  const results = [];

  if (args.commit) {
    // Real run, no rollback envelope
    for (const j of jobs) {
      try {
        const r = await runJob(j, realDb, args.limit);
        results.push(r);
        console.log(`${ok('✓')} ${bold(j)} ok in ${r.duration_ms}ms`, r);
      } catch (e) {
        results.push({ name: j, error: e.message });
        console.log(`${err('✗')} ${j} failed: ${e.message}`);
      }
    }
  } else {
    let restoreDb;
    try {
      await realDb.transaction(async (trx) => {
        restoreDb = patchDbModule(trx);
        for (const j of jobs) {
          try {
            const r = await runJob(j, trx, args.limit);
            results.push(r);
            console.log(`${ok('✓')} ${bold(j)} would-${dim('do')} in ${r.duration_ms}ms`, r);
          } catch (e) {
            results.push({ name: j, error: e.message });
            console.log(`${err('✗')} ${j} failed: ${e.message}`);
          }
        }
        // Always rollback
        const rollback = new Error('__intentional_rollback__');
        rollback.__rollback = true;
        throw rollback;
      });
    } catch (e) {
      if (!e.__rollback) {
        console.error(err(`Transaction blew up: ${e.stack || e.message}`));
      } else {
        console.log(`\n${dim('  → transaction rolled back, no rows persisted')}`);
      }
    } finally {
      if (restoreDb) restoreDb();
    }
  }

  await realDb.destroy();

  console.log(`\n${bold('═'.repeat(78))}`);
  console.log(bold(`Total: ${Date.now() - startedAt}ms across ${results.length} jobs`));
  for (const r of results) {
    if (r.error) {
      console.log(`  ${err('✗')} ${r.name?.padEnd(20) || '???'} ${err(r.error)}`);
    } else {
      const counters = Object.entries(r)
        .filter(([k]) => !['name', 'duration_ms', 'rows'].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(`  ${ok('✓')} ${r.name.padEnd(20)} rows=${r.rows} ${counters} ${dim(`(${r.duration_ms}ms)`)}`);
    }
  }
}

main().catch((e) => {
  console.error(err(`Fatal: ${e.stack || e.message}`));
  process.exit(1);
});
