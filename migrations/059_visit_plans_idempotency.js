/**
 * Visit-plan idempotency — prevent duplicate plans for same scope+period.
 *
 * Adds:
 *   visit_plans.scope_hash         — md5 of sorted scope (canonical key for idempotency)
 *   visit_plans.archived_at        — when a published plan was superseded by a newer publish
 *   UNIQUE INDEX                   — partial: only enforces among non-archived rows
 *
 * Why scope_hash instead of UNIQUE(scope_user_id, period_start, period_end):
 *   `scope_user_id` is NULL for multi-rep plans (the canonical case in production).
 *   We need a stable hash over the actual `scopeUserIds` set used at generation
 *   time. The application writes scope_hash on insert (cheap; ~10-80 reps).
 *
 * Backwards-compat:
 *   Existing rows get scope_hash backfilled to md5(coalesce(scope_user_id, '*')).
 *   Re-inserts that include the same scope_user_ids will get the same hash and
 *   trip the unique index, surfacing as 409 in the controller.
 */

exports.up = async function up(knex) {
  const hasHash = await knex.schema.hasColumn('visit_plans', 'scope_hash');
  if (!hasHash) {
    await knex.schema.alterTable('visit_plans', (t) => {
      t.specificType('scope_hash', 'char(32)');
    });
  }
  const hasArchivedAt = await knex.schema.hasColumn('visit_plans', 'archived_at');
  if (!hasArchivedAt) {
    await knex.schema.alterTable('visit_plans', (t) => {
      t.timestamp('archived_at').nullable();
    });
  }

  // Backfill scope_hash for existing rows so the unique index can be created.
  await knex.raw(`
    UPDATE visit_plans
       SET scope_hash = md5(COALESCE(scope_user_id::text, owner_user_id::text))
     WHERE scope_hash IS NULL
  `);

  // Partial unique index: only among rows that aren't archived. Allows
  // re-publishing a plan after archiving the previous one.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_visit_plans_scope_period_unique
      ON visit_plans (scope_hash, period_start, period_end)
      WHERE status IN ('draft','published') AND archived_at IS NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_visit_plans_archived_at
      ON visit_plans (archived_at)
      WHERE archived_at IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_visit_plans_archived_at;');
  await knex.raw('DROP INDEX IF EXISTS idx_visit_plans_scope_period_unique;');
  await knex.schema.alterTable('visit_plans', (t) => {
    t.dropColumn('archived_at');
    t.dropColumn('scope_hash');
  });
};
