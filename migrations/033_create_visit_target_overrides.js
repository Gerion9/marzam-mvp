/**
 * visit_target_overrides — per-subordinate override of `visit_targets`.
 *
 * A supervisor may decide that rep "Ana P." should hit 18/day instead of the
 * branch default of 23 (e.g. because she's training, on a difficult zone,
 * etc.). That row lives here, scoped to her user_id only.
 *
 * Resolution order (encapsulated in `resolve_visit_target`):
 *   1) most-recent override for the user / pareto / channel / on_date
 *   2) visit_targets row for (branch, pareto, channel, role)
 *   3) global visit_targets row (branch_id IS NULL)
 *   4) NULL → caller decides default behavior
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('visit_target_overrides', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('subordinate_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('set_by_user_id').references('id').inTable('users').onDelete('SET NULL');
    t.string('pareto_class', 1).notNullable();
    t.string('channel', 32).notNullable().defaultTo('visit');
    t.integer('daily_contacts_per_person').notNullable();
    t.text('reason');
    t.date('effective_from').notNullable().defaultTo(knex.raw('CURRENT_DATE'));
    t.date('effective_to');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE visit_target_overrides
      ADD CONSTRAINT vto_pareto_check
      CHECK (pareto_class IN ('A','B','C'));
  `);
  await knex.raw(`
    ALTER TABLE visit_target_overrides
      ADD CONSTRAINT vto_channel_check
      CHECK (channel IN ('visit','contact_center'));
  `);

  await knex.raw('CREATE INDEX idx_vto_subordinate ON visit_target_overrides (subordinate_user_id, effective_from DESC);');

  // resolve_visit_target(user_id, pareto_class, channel, on_date)
  // Returns the daily_contacts_per_person target effective for that user on
  // that date. Used by the plan generator and the API.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION resolve_visit_target(
      p_user_id      uuid,
      p_pareto_class char(1),
      p_channel      text,
      p_date         date
    ) RETURNS integer AS $$
    DECLARE
      v_role     text;
      v_branch   uuid;
      v_value    integer;
    BEGIN
      -- 1) per-user override
      SELECT daily_contacts_per_person
        INTO v_value
        FROM visit_target_overrides
       WHERE subordinate_user_id = p_user_id
         AND pareto_class = p_pareto_class
         AND channel = p_channel
         AND effective_from <= p_date
         AND (effective_to IS NULL OR effective_to >= p_date)
       ORDER BY effective_from DESC
       LIMIT 1;
      IF FOUND THEN RETURN v_value; END IF;

      -- 2) per-branch role default
      SELECT role, branch_id INTO v_role, v_branch FROM users WHERE id = p_user_id;
      IF v_role IS NULL THEN RETURN NULL; END IF;

      SELECT daily_contacts_per_person
        INTO v_value
        FROM visit_targets
       WHERE branch_id = v_branch
         AND pareto_class = p_pareto_class
         AND channel = p_channel
         AND role = v_role
         AND is_active = true
         AND effective_from <= p_date
         AND (effective_to IS NULL OR effective_to >= p_date)
       ORDER BY effective_from DESC
       LIMIT 1;
      IF FOUND THEN RETURN v_value; END IF;

      -- 3) global default
      SELECT daily_contacts_per_person
        INTO v_value
        FROM visit_targets
       WHERE branch_id IS NULL
         AND pareto_class = p_pareto_class
         AND channel = p_channel
         AND role = v_role
         AND is_active = true
         AND effective_from <= p_date
         AND (effective_to IS NULL OR effective_to >= p_date)
       ORDER BY effective_from DESC
       LIMIT 1;

      RETURN v_value;
    END;
    $$ LANGUAGE plpgsql STABLE;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP FUNCTION IF EXISTS resolve_visit_target(uuid, char, text, date);');
  await knex.schema.dropTableIfExists('visit_target_overrides');
};
