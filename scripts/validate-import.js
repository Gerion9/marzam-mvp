#!/usr/bin/env node
/**
 * Marzam imports — local dry-run validator.
 *
 * Reads a local .xlsx/.csv file, runs it through the same parser/aliases
 * that the production worker uses, and reports:
 *   - Header detection (mapped → canonical, day columns, noise dropped, unmapped)
 *   - Row sample (after alias normalization) — first N rows pretty-printed
 *   - Optional DB run inside a transaction that always rolls back, so you
 *     see what the processor would actually do without persisting anything
 *
 * Usage examples:
 *
 *   # Just inspect headers + a sample of normalized rows
 *   node scripts/validate-import.js \
 *     --kind marzam-clients \
 *     --file ./inicial/clientes-marzam-mes.xlsx
 *
 *   # Same but also run the processor against the DB inside a rollback'd tx
 *   node scripts/validate-import.js \
 *     --kind employees \
 *     --file ./inicial/padron-empleados.xlsx \
 *     --db
 *
 *   # daily_sales: the period (1st of month) belongs to the file as a whole
 *   node scripts/validate-import.js \
 *     --kind daily-sales \
 *     --file ./inicial/ventas-abril.xlsx \
 *     --period 2026-04-01 \
 *     --db
 *
 *   # Limit how many rows to show / process during dry-run
 *   node scripts/validate-import.js --kind marzam-clients --file x.xlsx --sample 5 --rows 100
 *
 * Exit codes:
 *   0 — file parsed, no errors (or only soft warnings about unmapped headers)
 *   1 — fatal error (file unreadable, kind unknown)
 *   2 — file parsed, but rows had hard validation failures
 */

const fs = require('fs');
const path = require('path');

const { readSheetRows } = require('../src/modules/imports/xlsxParser');
const {
  applyAliasMap,
  summarizeHeaders,
  MARZAM_CLIENTS_ALIASES,
  DAILY_SALES_ALIASES,
  EMPLOYEES_ALIASES,
  SALES_TARGETS_ALIASES,
} = require('../src/modules/imports/columnAliases');
const { PROCESSORS } = require('../src/modules/imports/processors');

const ALIAS_MAPS = {
  marzam_clients: MARZAM_CLIENTS_ALIASES,
  daily_sales: DAILY_SALES_ALIASES,
  employees: EMPLOYEES_ALIASES,
  sales_targets: SALES_TARGETS_ALIASES,
};

const KIND_URL_TO_DB = {
  'marzam-clients': 'marzam_clients',
  'daily-sales': 'daily_sales',
  'sales-targets': 'sales_targets',
  employees: 'employees',
};

function parseArgs(argv) {
  const args = { sample: 5, rows: null, db: false, kind: null, file: null, period: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--kind':
      case '-k':
        args.kind = next;
        i += 1;
        break;
      case '--file':
      case '-f':
        args.file = next;
        i += 1;
        break;
      case '--period':
      case '-p':
        args.period = next;
        i += 1;
        break;
      case '--sample':
      case '-s':
        args.sample = Number(next);
        i += 1;
        break;
      case '--rows':
      case '-n':
        args.rows = Number(next);
        i += 1;
        break;
      case '--db':
        args.db = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/validate-import.js --kind <k> --file <path> [options]

Options:
  --kind, -k       marzam-clients | daily-sales | employees | sales-targets   (required)
  --file, -f       path to .xlsx / .csv on disk                                (required)
  --period, -p     YYYY-MM-DD (1st of month). Required for daily-sales unless
                   the period is in the rows themselves.
  --sample, -s     how many normalized rows to pretty-print  [default: 5]
  --rows, -n       only process the first N rows (for big files)  [default: all]
  --db             actually execute the processor inside a tx that always rolls back
  -h, --help       show this help

Without --db, the script never opens a DB connection — safe to run anywhere.
`);
}

function colorize(text, code) {
  if (!process.stdout.isTTY) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const ok = (s) => colorize(s, '32');
const warn = (s) => colorize(s, '33');
const err = (s) => colorize(s, '31');
const dim = (s) => colorize(s, '2');
const bold = (s) => colorize(s, '1');

function header(title) {
  console.log(`\n${bold('═'.repeat(60))}`);
  console.log(bold(title));
  console.log(bold('═'.repeat(60)));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.kind || !args.file) {
    printHelp();
    process.exit(1);
  }
  const dbKind = KIND_URL_TO_DB[args.kind] || args.kind;
  const aliasMap = ALIAS_MAPS[dbKind];
  const processor = PROCESSORS[dbKind];
  if (!aliasMap || !processor) {
    console.error(err(`Unknown kind '${args.kind}'. Use one of: ${Object.keys(KIND_URL_TO_DB).join(', ')}`));
    process.exit(1);
  }

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    console.error(err(`File not found: ${filePath}`));
    process.exit(1);
  }

  const buffer = fs.readFileSync(filePath);
  console.log(ok(`✔ Loaded ${filePath} (${(buffer.length / 1024).toFixed(1)} KB)`));

  let rawRows;
  try {
    rawRows = readSheetRows(buffer);
  } catch (e) {
    console.error(err(`Failed to read sheet: ${e.message}`));
    process.exit(1);
  }
  if (args.rows && rawRows.length > args.rows) {
    rawRows = rawRows.slice(0, args.rows);
  }
  console.log(ok(`✔ Sheet parsed — ${rawRows.length} data rows`));

  // ---------- Header summary ----------
  header(`HEADERS (${dbKind})`);
  const summary = summarizeHeaders(rawRows, aliasMap, 50);
  console.log(`${ok('Mapped')}      (${Object.keys(summary.mapped).length} canonical fields):`);
  for (const [canonical, raws] of Object.entries(summary.mapped)) {
    console.log(`  ${canonical.padEnd(30)} ← ${raws.map((r) => `"${r}"`).join(', ')}`);
  }
  if (summary.day_columns.length) {
    console.log(`\n${ok('Day cols')}   (${summary.day_columns.length}): ${summary.day_columns.map((c) => `"${c}"`).join(', ')}`);
  }
  if (summary.noise.length) {
    console.log(`\n${dim('Noise')}      (${summary.noise.length} dropped): ${summary.noise.map((c) => `"${c}"`).join(', ')}`);
  }
  if (summary.unmapped.length) {
    console.log(`\n${warn('Unmapped')}   (${summary.unmapped.length} — review whether these need an alias):`);
    for (const u of summary.unmapped) {
      console.log(`  ${warn('?')} "${u}"`);
    }
  }

  // ---------- Sample rows ----------
  header(`SAMPLE (first ${Math.min(args.sample, rawRows.length)} rows after alias normalization)`);
  for (let i = 0; i < Math.min(args.sample, rawRows.length); i += 1) {
    const normalized = applyAliasMap(rawRows[i], aliasMap);
    console.log(`\n${dim(`# row ${i + 2} (Excel row, 1=header)`)}`);
    console.log(JSON.stringify(normalized, null, 2));
  }

  // ---------- Optional DB dry-run ----------
  if (args.db) {
    header(`DB DRY-RUN (transaction will be rolled back)`);
    if (dbKind === 'daily_sales' && !args.period) {
      console.log(warn('  ⚠ --period not given; will fall back to per-row period column.'));
    }
    let outcome;
    let db;
    try {
      db = require('../src/config/database');
      outcome = await db.transaction(async (trx) => {
        const normalized = rawRows.map((row, i) => ({
          rowNumber: i + 2,
          row: applyAliasMap(row, aliasMap),
        }));
        const meta = args.period ? { period: args.period } : {};
        const res = await processor.processBatch(trx, normalized, { meta, job: { id: 'dry-run' } });
        // Always rollback so nothing persists.
        const rollback = new Error('__intentional_rollback__');
        rollback.__rollback = true;
        rollback.outcome = res;
        throw rollback;
      });
    } catch (e) {
      if (e.__rollback) {
        outcome = e.outcome;
      } else {
        console.error(err(`DB dry-run failed: ${e.message}`));
        if (db) await db.destroy();
        process.exit(2);
      }
    }
    if (db) await db.destroy();

    console.log(`${ok('inserted')} (would insert): ${outcome.inserted}`);
    console.log(`${ok('updated')}  (would update): ${outcome.updated}`);
    console.log(`${dim('skipped')}  (silent skips): ${outcome.skipped}`);
    console.log(`${err('failed')}   (hard errors):  ${outcome.failed}`);
    if (outcome.errors?.length) {
      console.log(`\n${err('First 10 errors:')}`);
      for (const e of outcome.errors.slice(0, 10)) {
        console.log(`  row ${e.row}: ${err(e.reason)}`);
      }
      if (outcome.errors.length > 10) {
        console.log(dim(`  ... and ${outcome.errors.length - 10} more`));
      }
    }
    if (outcome.failed > 0) {
      process.exitCode = 2;
    }
  } else {
    console.log(dim('\n  (Use --db to actually run the processor in a rollback transaction.)'));
    if (summary.unmapped.length > 0) {
      process.exitCode = 0; // soft signal — unmapped is informational
    }
  }
}

main().catch((e) => {
  console.error(err(`Fatal: ${e.stack || e.message}`));
  process.exit(1);
});
