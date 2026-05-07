/**
 * pharmacy_presence — daily roll-up of "rep was near a pharmacy" derived from
 * `rep_tracking_points`.
 *
 * Computed by the daily reconcile-presence cron (runs at 8:30 UTC, before the
 * 9:00 tracking purge). Each row collapses all the pings for a given
 * (rep, pharmacy, day) tuple into:
 *   - dwell_seconds     — sum of contiguous time-in-radius across sessions
 *   - max/min distance  — distance from the pharmacy across the day's pings
 *   - first/last_seen   — the bracketing timestamps
 *   - has_visit_report  — was a visit_report submitted that same day for the
 *                         same (rep, pharmacy) pair? (FK visit_id)
 *
 * The point is to surface "presence without report" — moments where a rep was
 * physically there but did not register the visit. The cron is idempotent:
 * UPSERT on (rep_id, pharmacy_id, presence_date).
 *
 * Storage choice: a normal table (not a materialized view) so we can:
 *   1) UPSERT one day at a time without recomputing the whole window.
 *   2) Keep a real FK to visit_reports.id (for forensic traceability).
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('pharmacy_presence');
  if (has) return;

  await knex.schema.createTable('pharmacy_presence', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('rep_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('pharmacy_id').notNullable().references('id').inTable('pharmacies').onDelete('CASCADE');
    // Local day in America/Mexico_City. Computed from the recorded_at of pings.
    t.date('presence_date').notNullable();
    t.integer('dwell_seconds').notNullable();
    t.decimal('max_distance_m', 10, 2);
    t.decimal('min_distance_m', 10, 2);
    t.timestamp('first_seen_at').notNullable();
    t.timestamp('last_seen_at').notNullable();
    t.integer('ping_count').notNullable();
    t.boolean('has_visit_report').notNullable().defaultTo(false);
    // Nullable FK — set to NULL if the linked visit is deleted, so retention
    // sweeps of visit_reports never break presence rows.
    t.uuid('visit_id').references('id').inTable('visit_reports').onDelete('SET NULL');
    // min_distance_m > 500 (mirrored from src/utils/geoDistance.js — keep in sync).
    t.boolean('distance_warning').notNullable().defaultTo(false);
    t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());

    t.unique(['rep_id', 'pharmacy_id', 'presence_date']);
  });

  // Index for "give me this rep's recent presence rows" — sorted desc.
  await knex.raw(`
    CREATE INDEX idx_pp_rep_date
      ON pharmacy_presence (rep_id, presence_date DESC);
  `);
  // Index for "presence at this pharmacy across reps".
  await knex.raw(`
    CREATE INDEX idx_pp_pharm_date
      ON pharmacy_presence (pharmacy_id, presence_date DESC);
  `);
  // Partial index used by the coverage view to find "presence without report"
  // in a date range — most rows have has_visit_report=false so the partial
  // gives us a much smaller index.
  await knex.raw(`
    CREATE INDEX idx_pp_date_no_rep
      ON pharmacy_presence (presence_date)
      WHERE has_visit_report = false;
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pharmacy_presence');
};
