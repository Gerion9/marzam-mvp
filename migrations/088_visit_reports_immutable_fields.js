/**
 * visit_reports — extensions for the bonus-engine and audit-grade integrity.
 *
 *   marzam_client_id          — explicit link to marzam_clients (mig 026), so
 *                                "visit to existing client" is direct, not via
 *                                JOIN through pharmacies.dataplor_id.
 *   client_state_at_visit     — frozen at checkin: 'new' (prospect) | 'existing'
 *                                (Marzam client at the moment of the visit).
 *                                Even if the prospect later converts, the report
 *                                stays tagged 'new' → bonus engine reflects what
 *                                was true when the rep stood there.
 *   visit_plan_assignment_id  — immutable link to the originating assignment.
 *                                Closes the loop from plan → visit_report.
 *   deleted_at / deleted_by / deletion_reason — soft-delete. Hard-delete is
 *                                disallowed for audit reasons; queries filter
 *                                WHERE deleted_at IS NULL.
 *
 * Pharmacy ON DELETE CASCADE is intentionally NOT changed here — that requires
 * coordinating with the imports module's pharmacy-merge flow. Tracked separately.
 *
 * CHECK constraint added with NOT VALID + (deferred) VALIDATE so the migration
 * itself does not block writes on a populated table.
 */

exports.up = async function up(knex) {
  const checks = await Promise.all([
    knex.schema.hasColumn('visit_reports', 'marzam_client_id'),
    knex.schema.hasColumn('visit_reports', 'client_state_at_visit'),
    knex.schema.hasColumn('visit_reports', 'visit_plan_assignment_id'),
    knex.schema.hasColumn('visit_reports', 'deleted_at'),
    knex.schema.hasColumn('visit_reports', 'deleted_by'),
    knex.schema.hasColumn('visit_reports', 'deletion_reason'),
  ]);
  const [hasMc, hasState, hasVpa, hasDel, hasDelBy, hasDelR] = checks;

  await knex.schema.alterTable('visit_reports', (t) => {
    if (!hasMc) t.uuid('marzam_client_id').references('id').inTable('marzam_clients').onDelete('SET NULL');
    if (!hasState) t.text('client_state_at_visit');
    if (!hasVpa) t.uuid('visit_plan_assignment_id').references('id').inTable('visit_plan_assignments').onDelete('SET NULL');
    if (!hasDel) t.timestamp('deleted_at');
    if (!hasDelBy) t.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');
    if (!hasDelR) t.text('deletion_reason');
  });

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'vr_client_state_check'
           AND conrelid = 'visit_reports'::regclass
      ) THEN
        ALTER TABLE visit_reports
          ADD CONSTRAINT vr_client_state_check
          CHECK (client_state_at_visit IS NULL OR client_state_at_visit IN ('existing','new'))
          NOT VALID;
      END IF;
    END $$;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_vr_marzam_client
      ON visit_reports (marzam_client_id) WHERE marzam_client_id IS NOT NULL;
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_vr_vpa
      ON visit_reports (visit_plan_assignment_id) WHERE visit_plan_assignment_id IS NOT NULL;
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_vr_deleted
      ON visit_reports (deleted_at) WHERE deleted_at IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_vr_deleted;');
  await knex.raw('DROP INDEX IF EXISTS idx_vr_vpa;');
  await knex.raw('DROP INDEX IF EXISTS idx_vr_marzam_client;');
  await knex.raw('ALTER TABLE visit_reports DROP CONSTRAINT IF EXISTS vr_client_state_check;');
  await knex.schema.alterTable('visit_reports', (t) => {
    t.dropColumn('deletion_reason');
    t.dropColumn('deleted_by');
    t.dropColumn('deleted_at');
    t.dropColumn('visit_plan_assignment_id');
    t.dropColumn('client_state_at_visit');
    t.dropColumn('marzam_client_id');
  });
};
