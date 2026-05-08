/**
 * Cron job: parser perezoso de pharmacies.opening_hours/closing_hours → opening_hours_v2.
 *
 * Procesa farmacias con opening_hours_v2 IS NULL OR opening_hours_parsed_at IS NULL.
 * Batch de 500/run para no bloquear DB. Vercel Cron diario 03:00 UTC.
 *
 * Plan generator lee opening_hours_v2 (jsonb) para soft-window scheduling. Si parse
 * falla (parse_status='unparseable'), fallback default 09:00-19:00 mon-sat persistido
 * de todas formas, así el caller no necesita ramificar.
 *
 * Idempotente: rerunning sólo procesa rows nuevas o invalidadas (parsed_at NULL).
 */

const db = require('../../../config/database');
const { parseBatch } = require('../../../services/openingHoursParser');

const BATCH_SIZE = 500;

async function run({ batchSize = BATCH_SIZE, force = false } = {}) {
  const startedAt = Date.now();

  const query = db('pharmacies').select('id', 'opening_hours', 'closing_hours');
  if (!force) {
    query.whereNull('opening_hours_parsed_at');
  }
  query.limit(batchSize);
  const rows = await query;

  if (!rows.length) {
    return {
      job: 'parse_opening_hours',
      processed: 0,
      parsed: 0,
      unparseable: 0,
      ms_elapsed: Date.now() - startedAt,
    };
  }

  const parsed = parseBatch(rows);
  const now = db.fn.now();

  let parsedCount = 0;
  let unparseableCount = 0;

  await db.transaction(async (trx) => {
    for (const r of parsed) {
      if (r.opening_hours_parse_status === 'parsed') parsedCount += 1;
      else unparseableCount += 1;
      await trx('pharmacies')
        .where({ id: r.id })
        .update({
          opening_hours_v2: JSON.stringify(r.opening_hours_v2),
          opening_hours_parse_status: r.opening_hours_parse_status,
          opening_hours_parsed_at: now,
        });
    }
  });

  return {
    job: 'parse_opening_hours',
    processed: rows.length,
    parsed: parsedCount,
    unparseable: unparseableCount,
    ms_elapsed: Date.now() - startedAt,
  };
}

module.exports = { run };
