/**
 * visit_plans lineage — track replan history explicitly.
 *
 * Why:
 *   `archived_at` + `scope_hash` (mig 059) already keep the production
 *   invariant "max 1 non-archived plan per (scope, period)". But they don't
 *   record WHY a plan replaced its predecessor or WHAT version of the lineage
 *   we're on. The bonus engine + post-mortems need that for audit.
 *
 * Columns:
 *   parent_plan_id        — the plan this one replaces (NULL for initial).
 *   superseded_by_plan_id — set on the OLD plan when a child is created.
 *   version               — monotonic per lineage root (1 for initial; child
 *                            takes max(lineage.version) + 1). NOT per parent.
 *   replan_reason         — enum string. Why this version exists.
 *   triggered_by_user_id  — who pressed "generate".
 *   cutoff_at             — UTC instant of the cutoff decision at generation.
 *   working_days_snapshot — the working_days array used at generation time
 *                            (frozen — even if the branch later flips Saturday on).
 *
 * `version` and `replan_reason` are nullable for the backfill: existing rows
 * become version=1, replan_reason='initial' on first read; we don't UPDATE
 * 80+ rows in this migration.
 */

exports.up = async function up(knex) {
  const checks = await Promise.all([
    knex.schema.hasColumn('visit_plans', 'parent_plan_id'),
    knex.schema.hasColumn('visit_plans', 'superseded_by_plan_id'),
    knex.schema.hasColumn('visit_plans', 'version'),
    knex.schema.hasColumn('visit_plans', 'replan_reason'),
    knex.schema.hasColumn('visit_plans', 'triggered_by_user_id'),
    knex.schema.hasColumn('visit_plans', 'cutoff_at'),
    knex.schema.hasColumn('visit_plans', 'working_days_snapshot'),
  ]);
  const [hasParent, hasSuperseded, hasVersion, hasReason, hasTriggered, hasCutoff, hasWdSnap] = checks;

  await knex.schema.alterTable('visit_plans', (t) => {
    if (!hasParent) t.uuid('parent_plan_id').references('id').inTable('visit_plans').onDelete('SET NULL');
    if (!hasSuperseded) t.uuid('superseded_by_plan_id').references('id').inTable('visit_plans').onDelete('SET NULL');
    if (!hasVersion) t.integer('version').notNullable().defaultTo(1);
    if (!hasReason) t.text('replan_reason');
    if (!hasTriggered) t.uuid('triggered_by_user_id').references('id').inTable('users').onDelete('SET NULL');
    if (!hasCutoff) t.timestamp('cutoff_at');
    if (!hasWdSnap) t.specificType('working_days_snapshot', 'int[]');
  });

  // CHECK on replan_reason — allow NULL for existing rows.
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'visit_plans_replan_reason_check'
           AND conrelid = 'visit_plans'::regclass
      ) THEN
        ALTER TABLE visit_plans
          ADD CONSTRAINT visit_plans_replan_reason_check
          CHECK (replan_reason IS NULL OR replan_reason IN
            ('initial','mid_flight','rep_breakdown','desync_resolution','manual_override'));
      END IF;
    END $$;
  `);

  // Indexes for lineage traversal.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_visit_plans_parent
      ON visit_plans (parent_plan_id) WHERE parent_plan_id IS NOT NULL;
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_visit_plans_superseded_by
      ON visit_plans (superseded_by_plan_id) WHERE superseded_by_plan_id IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_visit_plans_superseded_by;');
  await knex.raw('DROP INDEX IF EXISTS idx_visit_plans_parent;');
  await knex.raw('ALTER TABLE visit_plans DROP CONSTRAINT IF EXISTS visit_plans_replan_reason_check;');
  await knex.schema.alterTable('visit_plans', (t) => {
    t.dropColumn('working_days_snapshot');
    t.dropColumn('cutoff_at');
    t.dropColumn('triggered_by_user_id');
    t.dropColumn('replan_reason');
    t.dropColumn('version');
    t.dropColumn('superseded_by_plan_id');
    t.dropColumn('parent_plan_id');
  });
};
