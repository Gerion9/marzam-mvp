/**
 * Backfill visit_reports.client_state_at_visit and visit_reports.marzam_client_id
 * for rows that pre-date migration 088.
 *
 * Strategy:
 *   - 'existing' iff `marzam_clients.pharmacy_id = visit_reports.pharmacy_id`
 *     (the client was already a Marzam customer at that time).
 *   - 'new' otherwise.
 *
 * Idempotent: only updates rows where the column is NULL.
 *
 * IMPORTANT: marzam_clients.pharmacy_id can change over time (when a prospect
 * gets converted). This backfill treats the CURRENT state as "what was true at
 * the time of the visit", which is an approximation. For accurate historical
 * reconstruction we would need to consult an audit log of client conversions,
 * which doesn't exist yet. Accept the approximation — visits already done before
 * mig 088 cannot be retroactively decorated more precisely.
 *
 * Batched: 5000 rows per UPDATE. Add a small sleep between batches so we don't
 * monopolize the connection pool.
 *
 * Usage:
 *   node scripts/backfill-visit-reports-client-state.js [--dry-run] [--batch=5000] [--max-rows=N]
 */

const db = require('../src/config/database');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const batchArg = args.find((a) => a.startsWith('--batch='));
  const maxArg = args.find((a) => a.startsWith('--max-rows='));
  const batch = Math.max(100, Number(batchArg?.split('=')[1] || 5000));
  const maxRows = Number(maxArg?.split('=')[1] || 0); // 0 = unlimited

  console.log(`[backfill] dry-run=${dryRun} batch=${batch} maxRows=${maxRows || 'unlimited'}`);

  const hasState = await db.schema.hasColumn('visit_reports', 'client_state_at_visit');
  const hasMc = await db.schema.hasColumn('visit_reports', 'marzam_client_id');
  if (!hasState || !hasMc) {
    console.error('[backfill] required columns missing — run migration 088 first.');
    process.exit(1);
  }

  const countRow = await db('visit_reports')
    .whereNull('client_state_at_visit')
    .count('* as c')
    .first();
  const total = Number(countRow?.c || 0);
  console.log(`[backfill] ${total} rows need client_state_at_visit`);

  if (total === 0) {
    console.log('[backfill] nothing to do.');
    await db.destroy();
    return;
  }

  let updated = 0;
  let pass = 0;
  while (updated < total) {
    pass += 1;
    const ids = await db('visit_reports')
      .whereNull('client_state_at_visit')
      .limit(batch)
      .select('id');
    if (ids.length === 0) break;
    const idList = ids.map((r) => r.id);

    if (dryRun) {
      // Report what WOULD happen on a small sample
      const sample = await db('visit_reports as vr')
        .whereIn('vr.id', idList.slice(0, 5))
        .leftJoin('marzam_clients as mc', 'mc.pharmacy_id', 'vr.pharmacy_id')
        .select('vr.id', 'vr.pharmacy_id', 'mc.id as mc_id');
      console.log(`[backfill] pass ${pass} dry-run sample:`, sample);
      updated += ids.length;
      if (maxRows && updated >= maxRows) break;
      continue;
    }

    // One UPDATE per pass via a CTE for atomicity within the batch.
    const result = await db.raw(`
      WITH lookup AS (
        SELECT vr.id AS vr_id, mc.id AS mc_id
          FROM visit_reports vr
          LEFT JOIN marzam_clients mc ON mc.pharmacy_id = vr.pharmacy_id
         WHERE vr.id = ANY(?::uuid[])
      )
      UPDATE visit_reports vr
         SET client_state_at_visit = CASE WHEN l.mc_id IS NOT NULL THEN 'existing' ELSE 'new' END,
             marzam_client_id = l.mc_id
        FROM lookup l
       WHERE vr.id = l.vr_id
         AND vr.client_state_at_visit IS NULL
    `, [idList]);
    const rowCount = result.rowCount || idList.length;
    updated += rowCount;
    console.log(`[backfill] pass ${pass}: ${rowCount} rows updated (total ${updated}/${total})`);

    if (maxRows && updated >= maxRows) {
      console.log(`[backfill] --max-rows=${maxRows} reached.`);
      break;
    }

    // Sleep 250ms between batches — keep the connection pool breathing.
    await new Promise((r) => setTimeout(r, 250));
  }

  // After backfill, validate the CHECK constraint that mig 088 added with NOT VALID.
  if (!dryRun) {
    try {
      await db.raw('ALTER TABLE visit_reports VALIDATE CONSTRAINT vr_client_state_check');
      console.log('[backfill] vr_client_state_check VALIDATED');
    } catch (err) {
      console.warn(`[backfill] could not VALIDATE constraint: ${err.message}`);
    }
  }

  console.log(`[backfill] done: ${updated} rows updated.`);
  await db.destroy();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
