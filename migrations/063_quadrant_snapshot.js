/**
 * Stable snapshot of pharmacy quadrants — written weekly by the Vercel Cron
 * job /api/admin/quadrants/snapshot, read at plan generation time so the
 * A/B/C/D tier of a prospect doesn't shift mid-week as new BQ scores roll in.
 *
 * Replaces the unstable `pharmacies.quadrant_derived` NTILE recompute that
 * was happening on every BQ sync.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('quadrant_snapshot');
  if (has) return;
  await knex.schema.createTable('quadrant_snapshot', (t) => {
    t.date('period_start').notNullable();
    t.uuid('pharmacy_id').notNullable().references('id').inTable('pharmacies').onDelete('CASCADE');
    t.text('quadrant').notNullable();
    t.decimal('final_score', 8, 4);
    t.timestamp('snapshotted_at').defaultTo(knex.fn.now());
    t.primary(['period_start', 'pharmacy_id']);
  });
  await knex.raw(`
    ALTER TABLE quadrant_snapshot
      ADD CONSTRAINT quadrant_snapshot_quadrant_check
      CHECK (quadrant IN ('Q1','Q2','Q3','Q4'));
  `);
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_qsnap_pharmacy ON quadrant_snapshot (pharmacy_id);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('quadrant_snapshot');
};
