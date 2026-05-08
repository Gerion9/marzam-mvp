/**
 * Alerts engine — Marzam Execution Doc §8.
 *
 * Six mandatory alert rules:
 *   1) Route not started by X time
 *   2) Route deviated significantly
 *   3) Visit missing required photo (already enforced server-side; alert is
 *      a manager notification when it happens repeatedly)
 *   4) Rep inactive too long during route
 *   5) Customer marked closed/duplicate → notify manager
 *   6) Onboarding docs pending too long → notify admin
 *
 * `alerts` is the durable feed each user (and their managers) consumes via
 * `GET /api/alerts/feed`. `alert_rules` keeps thresholds configurable so the
 * V1 set "exact alert thresholds (X time, deviation meters, inactivity
 * minutes)" — listed as open in §14 — can be tuned without a code deploy.
 *
 * Notes:
 *  - `alerts.alert_key` lets dismissals (already in alert_dismissals) keep
 *    matching across regenerations of the same condition.
 *  - `expires_at` is for self-resolving alerts (e.g. inactivity that fixes
 *    itself when the rep starts moving again).
 *  - One enforcement we DO at the DB level: a partial unique index on
 *    (subject_user_id, alert_key, fire_window) so the cron-style evaluator
 *    can re-run idempotently without producing duplicate alerts in the same
 *    evaluation window.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('alert_rules', (t) => {
    t.text('key').primary();              // matches alerts.rule_key
    t.text('description').notNullable();
    t.string('severity', 16).notNullable().defaultTo('info'); // info|warn|critical
    t.boolean('enabled').notNullable().defaultTo(true);
    t.jsonb('thresholds').notNullable().defaultTo('{}'); // free-form {minutes:..., meters:...}
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('alerts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.text('rule_key').notNullable().references('key').inTable('alert_rules').onDelete('CASCADE');
    t.text('alert_key').notNullable(); // stable key for de-dup + dismissals
    t.uuid('subject_user_id').references('id').inTable('users').onDelete('CASCADE'); // who the alert is ABOUT
    t.uuid('audience_user_id').references('id').inTable('users').onDelete('CASCADE'); // who should see it (NULL = managers of subject)
    t.string('severity', 16).notNullable().defaultTo('info');
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.timestamp('fire_window_start');
    t.timestamp('fire_window_end');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('resolved_at');
    t.timestamp('expires_at');
  });

  await knex.raw(`
    CREATE INDEX idx_alerts_audience_unresolved
      ON alerts (audience_user_id)
      WHERE resolved_at IS NULL;
  `);
  await knex.raw(`
    CREATE INDEX idx_alerts_subject_unresolved
      ON alerts (subject_user_id)
      WHERE resolved_at IS NULL;
  `);
  // De-dup: don't fire the same alert_key for the same subject in the same
  // fire_window. Allows the cron to be idempotent.
  await knex.raw(`
    CREATE UNIQUE INDEX uniq_alert_per_window
      ON alerts (rule_key, alert_key, subject_user_id, fire_window_start)
      WHERE resolved_at IS NULL;
  `);

  // Seed default rules with sensible thresholds. These are mutable post-deploy.
  await knex('alert_rules').insert([
    {
      key: 'route_not_started_by_x',
      description: 'Route not started within N minutes of expected_route_start',
      severity: 'warn',
      thresholds: JSON.stringify({ grace_minutes: 30 }),
    },
    {
      key: 'route_deviated_significantly',
      description: 'Rep is more than N meters away from any planned stop while route active',
      severity: 'warn',
      thresholds: JSON.stringify({ deviation_meters: 1500 }),
    },
    {
      key: 'visit_missing_photo',
      description: 'Visit closed without photo evidence (server-side block triggered)',
      severity: 'critical',
      thresholds: JSON.stringify({}),
    },
    {
      key: 'rep_inactive_too_long',
      description: 'Active visit_session has no ping for more than N minutes',
      severity: 'warn',
      thresholds: JSON.stringify({ idle_minutes: 25 }),
    },
    {
      key: 'customer_closed_or_duplicate',
      description: 'Pharmacy reported as closed or duplicate by rep',
      severity: 'info',
      thresholds: JSON.stringify({}),
    },
    {
      key: 'onboarding_docs_pending_too_long',
      description: 'Pharmacy onboarding case waiting on legal/finanzas more than N days',
      severity: 'warn',
      thresholds: JSON.stringify({ pending_days: 5 }),
    },
  ]);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('alerts');
  await knex.schema.dropTableIfExists('alert_rules');
};
