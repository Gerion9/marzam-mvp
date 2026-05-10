/**
 * plan_conflict_alerts — surface "manager published a weekly while a monthly
 * was active". The alert is informational; the actual collision-resolution
 * happens in the same transaction (conflictDetector marks the colliding
 * monthly assignments as 'rescheduled' to preserve the "one plan vigente
 * per rep+day" invariant).
 *
 * status transitions:
 *   pending      — created by conflictDetector.
 *   acknowledged — manager dismissed the warning (no replan).
 *   reoptimized  — manager triggered "Re-optimizar resto del mes"; resolution_plan_id
 *                  points to the new plan.
 *   dismissed    — soft-deleted equivalent.
 *
 * Idempotency: a unique index over (new_plan_id, conflicting_plan_id) WHERE
 * status='pending' prevents duplicates if conflictDetector runs twice (e.g.
 * publish retry).
 */

exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('plan_conflict_alerts');
  if (exists) return;

  await knex.schema.createTable('plan_conflict_alerts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('new_plan_id').notNullable().references('id').inTable('visit_plans').onDelete('CASCADE');
    t.uuid('conflicting_plan_id').notNullable().references('id').inTable('visit_plans').onDelete('CASCADE');
    t.uuid('branch_id').references('id').inTable('branches').onDelete('SET NULL');
    t.text('conflict_type').notNullable();
    t.date('affected_period_start').notNullable();
    t.date('affected_period_end').notNullable();
    t.text('severity').notNullable().defaultTo('warn');
    t.text('status').notNullable().defaultTo('pending');
    t.uuid('resolution_plan_id').references('id').inTable('visit_plans').onDelete('SET NULL');
    t.uuid('acknowledged_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('acknowledged_at');
    t.text('message');
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE plan_conflict_alerts
      ADD CONSTRAINT pca_status_check
        CHECK (status IN ('pending','acknowledged','reoptimized','dismissed')),
      ADD CONSTRAINT pca_severity_check
        CHECK (severity IN ('info','warn','critical')),
      ADD CONSTRAINT pca_type_check
        CHECK (conflict_type IN ('weekly_overrides_monthly','daily_overrides_weekly','daily_overrides_monthly','custom_overlap'));
  `);

  // Idempotency: at most one 'pending' alert per (new, conflicting).
  await knex.raw(`
    CREATE UNIQUE INDEX idx_pca_unique_pending
      ON plan_conflict_alerts (new_plan_id, conflicting_plan_id)
      WHERE status = 'pending';
  `);

  // Dashboard query: alerts for a branch, sorted by recency.
  await knex.raw(`
    CREATE INDEX idx_pca_branch_status
      ON plan_conflict_alerts (branch_id, status, created_at DESC);
  `);

  // Lookup by new_plan / conflicting_plan.
  await knex.raw(`
    CREATE INDEX idx_pca_new_plan ON plan_conflict_alerts (new_plan_id);
  `);
  await knex.raw(`
    CREATE INDEX idx_pca_conflicting_plan ON plan_conflict_alerts (conflicting_plan_id);
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('plan_conflict_alerts');
};
