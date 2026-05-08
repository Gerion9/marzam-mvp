/**
 * visit_plan_assignments — metadata para reoptimizer intradía.
 *
 *   reopt_lock_kind     — durante una reoptimización indica si la fila puede o
 *                         no moverse:
 *                           'hard'     : status IN ('done','in_progress') → nunca se mueve
 *                           'soft'     : próximas 1-2 paradas 'planned' → se preservan
 *                           'released' : libres para reoptimizar
 *                           NULL       : sin reopt en curso
 *   last_reopt_id       — última reoptimización que tocó la fila. Permite tracear
 *                         de un assignment al audit row.
 *   urgent_inserted_at  — stamp de creación cuando la fila se insertó vía
 *                         urgent_insert. Usado por la UI para mostrar badge "URGENT".
 */

exports.up = async function up(knex) {
  const cols = await Promise.all([
    knex.schema.hasColumn('visit_plan_assignments', 'reopt_lock_kind'),
    knex.schema.hasColumn('visit_plan_assignments', 'last_reopt_id'),
    knex.schema.hasColumn('visit_plan_assignments', 'urgent_inserted_at'),
  ]);
  const [hasLock, hasReoptId, hasUrgent] = cols;
  if (!hasLock || !hasReoptId || !hasUrgent) {
    await knex.schema.alterTable('visit_plan_assignments', (t) => {
      if (!hasLock) t.text('reopt_lock_kind');
      if (!hasReoptId) t.uuid('last_reopt_id').references('id').inTable('visit_plan_reoptimizations').onDelete('SET NULL');
      if (!hasUrgent) t.timestamp('urgent_inserted_at');
    });
  }
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vpa_reopt_lock_check'
          AND conrelid = 'visit_plan_assignments'::regclass
      ) THEN
        ALTER TABLE visit_plan_assignments
          ADD CONSTRAINT vpa_reopt_lock_check
          CHECK (reopt_lock_kind IS NULL OR reopt_lock_kind IN ('hard','soft','released'));
      END IF;
    END $$;
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_vpa_reopt_lock
      ON visit_plan_assignments (visit_plan_id, scheduled_date, reopt_lock_kind)
      WHERE reopt_lock_kind IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_vpa_reopt_lock;');
  await knex.raw('ALTER TABLE visit_plan_assignments DROP CONSTRAINT IF EXISTS vpa_reopt_lock_check;');
  await knex.schema.alterTable('visit_plan_assignments', (t) => {
    t.dropColumn('reopt_lock_kind');
    t.dropColumn('last_reopt_id');
    t.dropColumn('urgent_inserted_at');
  });
};
