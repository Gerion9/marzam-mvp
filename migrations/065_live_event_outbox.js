/**
 * Live event outbox — durable buffer so SSE subscribers can replay events
 * after a server restart, and so multi-instance deployments share state via
 * pg_notify instead of an in-memory EventEmitter that would silo each
 * process.
 *
 * The live.service publishes to this table; LISTEN/NOTIFY on `live_events`
 * pushes the row id to all connected processes, which then read the payload.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('live_event_outbox');
  if (has) return;
  await knex.schema.createTable('live_event_outbox', (t) => {
    t.bigIncrements('id').primary();
    t.text('event_type').notNullable();
    t.uuid('subject_user_id');
    t.uuid('audience_user_id');
    t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_live_event_outbox_created_at
      ON live_event_outbox (created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_live_event_outbox_subject
      ON live_event_outbox (subject_user_id, created_at DESC)
      WHERE subject_user_id IS NOT NULL
  `);

  // Trigger emits a NOTIFY whenever a new event is appended.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION live_event_notify_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('live_events', NEW.id::text);
      RETURN NEW;
    END;
    $$;
  `);
  await knex.raw(`
    DROP TRIGGER IF EXISTS live_event_outbox_notify ON live_event_outbox;
    CREATE TRIGGER live_event_outbox_notify
      AFTER INSERT ON live_event_outbox
      FOR EACH ROW EXECUTE FUNCTION live_event_notify_fn();
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS live_event_outbox_notify ON live_event_outbox;');
  await knex.raw('DROP FUNCTION IF EXISTS live_event_notify_fn;');
  await knex.schema.dropTableIfExists('live_event_outbox');
};
