/**
 * Quotas expansion — matriz 4×7 + capacidad por rol.
 *
 * Adds:
 *   visit_targets.category_kind  — 'marzam' | 'prospecto'
 *   visit_targets.days_share     — % of role's working days dedicated to this cell (0-100)
 *   role_capacity_targets (NEW)  — target headcount + days_per_month by (poblacion, role)
 *   resolve_visit_target_v2()    — SQL function with category_kind discriminator
 *                                   (fallback to v1 for backward compat)
 *
 * Why category_kind instead of repurposing pareto_class='D':
 *   The existing unique key and check constraints only allow A/B/C for pareto_class.
 *   Introducing a separate discriminator keeps the schema backward-compatible —
 *   existing queries that don't pass category_kind still resolve through the v1
 *   function and see only 'marzam' rows.
 *
 * Backward compat:
 *   All existing rows are backfilled with category_kind='marzam'.
 *   resolve_visit_target() (v1) is untouched.
 *   resolve_visit_target_v2() falls back to v1 if no matching row is found.
 */

exports.up = async function up(knex) {
  // ─── visit_targets: add category_kind column ──────────────────────────────
  const hasKind = await knex.schema.hasColumn('visit_targets', 'category_kind');
  if (!hasKind) {
    await knex.schema.alterTable('visit_targets', (t) => {
      t.string('category_kind', 10).notNullable().defaultTo('marzam');
    });
  }

  // Add check constraint for category_kind
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'visit_targets_category_kind_check'
          AND conrelid = 'visit_targets'::regclass
      ) THEN
        ALTER TABLE visit_targets
          ADD CONSTRAINT visit_targets_category_kind_check
          CHECK (category_kind IN ('marzam','prospecto'));
      END IF;
    END $$;
  `);

  // Allow pareto D only for prospecto rows
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'visit_targets_pareto_category_check'
          AND conrelid = 'visit_targets'::regclass
      ) THEN
        ALTER TABLE visit_targets
          ADD CONSTRAINT visit_targets_pareto_category_check
          CHECK (
            (category_kind = 'prospecto' AND pareto_class IN ('A','B','C','D'))
            OR
            (category_kind = 'marzam'    AND pareto_class IN ('A','B','C'))
          );
      END IF;
    END $$;
  `);

  // ─── visit_targets: add days_share column ────────────────────────────────
  const hasShare = await knex.schema.hasColumn('visit_targets', 'days_share');
  if (!hasShare) {
    await knex.schema.alterTable('visit_targets', (t) => {
      t.decimal('days_share', 5, 2).nullable().comment(
        'Percentage (0-100) of role\'s monthly working days dedicated to this cell. NULL = uniform distribution.',
      );
    });
  }

  // Backfill: existing rows are all marzam kind (defaultTo handled above)

  // ─── role_capacity_targets ────────────────────────────────────────────────
  const hasTable = await knex.schema.hasTable('role_capacity_targets');
  if (!hasTable) {
    await knex.schema.createTable('role_capacity_targets', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('poblacion', 255).nullable(); // NULL = applies to all / global
      t.string('role', 50).notNullable();
      t.integer('target_headcount').notNullable().defaultTo(0);
      t.integer('days_per_month').notNullable().defaultTo(22);
      t.uuid('set_by_user_id').nullable().references('id').inTable('users');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.unique(['poblacion', 'role']);
    });

    await knex.raw(`
      ALTER TABLE role_capacity_targets
        ADD CONSTRAINT role_capacity_days_range
        CHECK (days_per_month BETWEEN 0 AND 31);
    `);

    await knex.raw(`
      CREATE INDEX idx_role_capacity_poblacion
        ON role_capacity_targets (poblacion);
    `);
  }

  // ─── resolve_visit_target_v2 ──────────────────────────────────────────────
  // Keeps v1 untouched; adds v2 that respects category_kind discriminator.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION resolve_visit_target_v2(
      p_user_id      UUID,
      p_pareto       CHAR(1),
      p_channel      TEXT,
      p_date         DATE,
      p_category_kind TEXT DEFAULT 'marzam'
    )
    RETURNS INT LANGUAGE plpgsql STABLE AS $$
    DECLARE
      v_result INT;
      v_role   TEXT;
      v_branch UUID;
    BEGIN
      SELECT role, branch_id INTO v_role, v_branch
      FROM users WHERE id = p_user_id;

      -- 1. Per-user override (not affected by category_kind)
      SELECT daily_contacts_per_person INTO v_result
      FROM visit_target_overrides
      WHERE subordinate_user_id = p_user_id
        AND pareto_class = p_pareto
        AND channel = p_channel
        AND effective_from <= p_date
        AND (effective_to IS NULL OR effective_to >= p_date)
      ORDER BY effective_from DESC
      LIMIT 1;
      IF FOUND THEN RETURN v_result; END IF;

      -- 2. Branch-specific target with category_kind
      SELECT vt.daily_contacts_per_person INTO v_result
      FROM visit_targets vt
      WHERE vt.branch_id = v_branch
        AND vt.pareto_class = p_pareto
        AND vt.channel = p_channel
        AND vt.category_kind = p_category_kind
        AND vt.role = v_role
        AND vt.is_active = TRUE
        AND vt.effective_from <= p_date
        AND (vt.effective_to IS NULL OR vt.effective_to >= p_date)
      ORDER BY vt.effective_from DESC
      LIMIT 1;
      IF FOUND THEN RETURN v_result; END IF;

      -- 3. Global default with category_kind
      SELECT vt.daily_contacts_per_person INTO v_result
      FROM visit_targets vt
      WHERE vt.branch_id IS NULL
        AND vt.pareto_class = p_pareto
        AND vt.channel = p_channel
        AND vt.category_kind = p_category_kind
        AND vt.role = v_role
        AND vt.is_active = TRUE
        AND vt.effective_from <= p_date
        AND (vt.effective_to IS NULL OR vt.effective_to >= p_date)
      ORDER BY vt.effective_from DESC
      LIMIT 1;
      IF FOUND THEN RETURN v_result; END IF;

      -- 4. Fallback: original v1 function (only for 'marzam' kind)
      IF p_category_kind = 'marzam' THEN
        RETURN resolve_visit_target(p_user_id, p_pareto, p_channel, p_date);
      END IF;

      RETURN 0;
    END;
    $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP FUNCTION IF EXISTS resolve_visit_target_v2;');
  await knex.raw('DROP INDEX IF EXISTS idx_role_capacity_poblacion;');
  await knex.schema.dropTableIfExists('role_capacity_targets');

  await knex.raw(`
    ALTER TABLE visit_targets
      DROP CONSTRAINT IF EXISTS visit_targets_pareto_category_check;
  `);
  await knex.raw(`
    ALTER TABLE visit_targets
      DROP CONSTRAINT IF EXISTS visit_targets_category_kind_check;
  `);

  await knex.schema.alterTable('visit_targets', (t) => {
    t.dropColumn('days_share');
    t.dropColumn('category_kind');
  });
};
