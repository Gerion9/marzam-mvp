/**
 * daily_sales — fact table of monthly sales unrolled to one row per
 * (client, date). Partitioned by month on `sale_date` so we can drop / archive
 * old months cheaply once volume grows (target: ~1.8M rows/year).
 *
 * The `ensure_monthly_partition(date)` helper is created here and invoked for
 * the current and following month at migration time. The imports worker will
 * call it on every run so we never INSERT into a non-existent partition.
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE daily_sales (
      marzam_client_id uuid NOT NULL REFERENCES marzam_clients(id) ON DELETE CASCADE,
      sale_date        date NOT NULL,
      amount           numeric(14, 2) NOT NULL DEFAULT 0,
      is_devolution    boolean NOT NULL DEFAULT false,
      is_contact_center boolean NOT NULL DEFAULT false,
      imported_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (marzam_client_id, sale_date)
    ) PARTITION BY RANGE (sale_date);
  `);

  await knex.raw(`
    CREATE INDEX idx_daily_sales_date_client
      ON daily_sales (sale_date, marzam_client_id);
  `);

  // Helper to lazily provision monthly partitions.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ensure_monthly_partition(p_date date)
    RETURNS void AS $$
    DECLARE
      start_date date := date_trunc('month', p_date)::date;
      end_date   date := (date_trunc('month', p_date) + interval '1 month')::date;
      part_name  text := 'daily_sales_' || to_char(start_date, 'YYYY_MM');
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF daily_sales FOR VALUES FROM (%L) TO (%L);',
        part_name, start_date, end_date
      );
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Provision current and next month partitions up-front.
  await knex.raw(`SELECT ensure_monthly_partition(CURRENT_DATE);`);
  await knex.raw(`SELECT ensure_monthly_partition((CURRENT_DATE + INTERVAL '1 month')::date);`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS daily_sales CASCADE;');
  await knex.raw('DROP FUNCTION IF EXISTS ensure_monthly_partition(date);');
};
