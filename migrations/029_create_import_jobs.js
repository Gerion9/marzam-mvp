/**
 * import_jobs — audit + work queue for Excel/CSV uploads.
 *
 * The `kind` column controls which parser the worker dispatches to:
 *   - marzam_clients
 *   - daily_sales
 *   - employees
 *   - sales_targets
 *
 * Status flow: pending → processing → done | failed | partial
 *
 * `cursor` lets the worker resume in chunks across multiple cron ticks (Vercel
 * function timeouts cap us around 60–300s). `errors` is an append-only jsonb
 * array of `{row_number, reason, raw}` records.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('import_jobs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('kind', 32).notNullable();
    t.uuid('uploaded_by').references('id').inTable('users').onDelete('SET NULL');
    t.text('file_storage_path').notNullable();
    t.text('original_filename');

    t.string('status', 16).notNullable().defaultTo('pending');
    t.integer('rows_total').notNullable().defaultTo(0);
    t.integer('rows_inserted').notNullable().defaultTo(0);
    t.integer('rows_updated').notNullable().defaultTo(0);
    t.integer('rows_skipped').notNullable().defaultTo(0);
    t.integer('rows_failed').notNullable().defaultTo(0);
    t.integer('cursor').notNullable().defaultTo(0);
    t.jsonb('errors').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    t.jsonb('meta').notNullable().defaultTo(knex.raw("'{}'::jsonb"));

    t.timestamp('started_at');
    t.timestamp('finished_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE import_jobs
      ADD CONSTRAINT import_jobs_kind_check
      CHECK (kind IN ('marzam_clients', 'daily_sales', 'employees', 'sales_targets'));
  `);

  await knex.raw(`
    ALTER TABLE import_jobs
      ADD CONSTRAINT import_jobs_status_check
      CHECK (status IN ('pending', 'processing', 'done', 'failed', 'partial'));
  `);

  await knex.raw('CREATE INDEX idx_import_jobs_status ON import_jobs (status);');
  await knex.raw('CREATE INDEX idx_import_jobs_kind ON import_jobs (kind);');
  await knex.raw('CREATE INDEX idx_import_jobs_uploaded_by ON import_jobs (uploaded_by);');
  await knex.raw('CREATE INDEX idx_import_jobs_created_at ON import_jobs (created_at DESC);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('import_jobs');
};
