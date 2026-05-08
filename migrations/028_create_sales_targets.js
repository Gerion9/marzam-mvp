/**
 * sales_targets — monthly objective per client.
 *
 * Plus mv_avance_mensual: a materialized view that joins targets with the sum
 * of `daily_sales` per period, so the dashboard can read "Avance %" in O(1).
 * Refresh via cron (REFRESH MATERIALIZED VIEW CONCURRENTLY mv_avance_mensual).
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('sales_targets', (t) => {
    t.uuid('marzam_client_id').notNullable().references('id').inTable('marzam_clients').onDelete('CASCADE');
    t.date('period').notNullable();

    t.decimal('objetivo', 14, 2).defaultTo(0);
    t.decimal('presupuesto', 14, 2).defaultTo(0);
    t.decimal('importe_para_objetivo', 14, 2).defaultTo(0);

    t.integer('mostradores_para_venta');
    t.integer('mostradores_con_venta');

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.primary(['marzam_client_id', 'period']);
  });

  // period must be the first day of the month
  await knex.raw(`
    ALTER TABLE sales_targets
      ADD CONSTRAINT sales_targets_period_first_of_month_check
      CHECK (period = date_trunc('month', period)::date);
  `);

  await knex.raw(`
    CREATE MATERIALIZED VIEW mv_avance_mensual AS
    SELECT
      st.marzam_client_id,
      st.period,
      st.objetivo,
      st.presupuesto,
      COALESCE(s.amount_total, 0)::numeric(14, 2) AS amount_total,
      CASE
        WHEN st.objetivo IS NULL OR st.objetivo = 0 THEN NULL
        ELSE ROUND((COALESCE(s.amount_total, 0) / st.objetivo) * 100, 2)
      END AS avance_pct,
      st.mostradores_para_venta,
      st.mostradores_con_venta
    FROM sales_targets st
    LEFT JOIN LATERAL (
      SELECT SUM(amount) AS amount_total
      FROM daily_sales ds
      WHERE ds.marzam_client_id = st.marzam_client_id
        AND ds.sale_date >= st.period
        AND ds.sale_date < (st.period + INTERVAL '1 month')::date
        AND ds.is_devolution = false
    ) s ON true;
  `);

  // CONCURRENTLY refresh requires a unique index.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_mv_avance_mensual_pk
      ON mv_avance_mensual (marzam_client_id, period);
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_avance_mensual;');
  await knex.schema.dropTableIfExists('sales_targets');
};
