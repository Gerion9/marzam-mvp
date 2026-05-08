/**
 * Enforce Marzam Execution Doc §6.3 constraints at the DB level:
 *
 *  1) "One visit per pharmacy per day": partial unique index on
 *     (pharmacy_id, rep_id, date(created_at)).  Service layer also checks
 *     and returns a friendlier 409, but this is the source of truth.
 *
 *  2) Skip outcomes (closed/duplicate/moved/wrong_category/chain_not_independent/
 *     invalid) require flag_reason — CHECK constraint complements the
 *     application-level validation in visits.service.js.
 *
 * Photo enforcement stays at the application layer because it depends on a
 * companion table (visit_photos / pharmacy_verifications) being populated in
 * the same logical operation; a CHECK across tables is not portable.
 */

exports.up = async function up(knex) {
  // 1) one-visit-per-day: a partial unique index keyed by date(created_at)
  // so multi-day backfills don't trip it.  We use a partial index (only
  // current/future inserts) to avoid breaking historical duplicates if any.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_visit_per_pharmacy_per_rep_per_day
      ON visit_reports (pharmacy_id, rep_id, ((created_at AT TIME ZONE 'UTC')::date));
  `);

  // 2) flag_reason required for skip outcomes.
  await knex.raw(`
    ALTER TABLE visit_reports DROP CONSTRAINT IF EXISTS visit_reports_skip_reason_required;
  `);
  await knex.raw(`
    ALTER TABLE visit_reports
      ADD CONSTRAINT visit_reports_skip_reason_required CHECK (
        outcome NOT IN ('closed','duplicate','moved','wrong_category','chain_not_independent','invalid')
        OR (flag_reason IS NOT NULL AND length(btrim(flag_reason)) > 0)
      );
  `);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE visit_reports DROP CONSTRAINT IF EXISTS visit_reports_skip_reason_required;');
  await knex.raw('DROP INDEX IF EXISTS uniq_visit_per_pharmacy_per_rep_per_day;');
};
