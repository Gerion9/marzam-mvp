/**
 * Weekly snapshot of pharmacy quadrants.
 *
 * Run by Vercel Cron at Sunday 02:00 CDMX (08:00 UTC). Reads the current
 * `pharmacies.quadrant_derived` (which BQ sync mutates on every run) and
 * persists a frozen copy to `quadrant_snapshot` keyed by the snapshot
 * period_start (Monday of that ISO week).
 *
 * Plan generator reads from `quadrant_snapshot` for the closest period_start
 * <= plan.period_start, so a plan generated mid-week never sees a Tuesday-shift
 * in the prospect tier of a pharmacy.
 *
 * Idempotent: rerunning for the same period_start replaces the rows.
 */

const db = require('../../../config/database');

/**
 * Get Monday of the ISO week containing `date` (UTC).
 */
function isoMonday(date) {
  const d = new Date(date);
  const day = d.getUTCDay() || 7; // 1..7, Mon=1
  d.setUTCDate(d.getUTCDate() - day + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

async function run({ periodStart } = {}) {
  const ps = periodStart || isoMonday(new Date());
  // Snapshot every active pharmacy's current quadrant_derived (or quadrant
  // if derived is null). Skip rows with no quadrant.
  const rows = await db('pharmacies')
    .whereIn('status', ['active', 'pending'])
    .whereRaw('COALESCE(quadrant_derived, quadrant) IS NOT NULL')
    .select('id', 'final_score',
      db.raw('COALESCE(quadrant_derived, quadrant) AS q'));
  if (!rows.length) return { period_start: ps, count: 0 };

  // Bulk upsert via a temp table approach for speed on large datasets.
  await db.transaction(async (trx) => {
    // Drop any existing snapshot for this period_start so reruns are clean.
    await trx('quadrant_snapshot').where({ period_start: ps }).del();
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await trx('quadrant_snapshot').insert(
        rows.slice(i, i + CHUNK).map((r) => ({
          period_start: ps,
          pharmacy_id: r.id,
          quadrant: r.q,
          final_score: r.final_score,
        })),
      );
    }
  });
  return { period_start: ps, count: rows.length };
}

module.exports = { run, isoMonday };
