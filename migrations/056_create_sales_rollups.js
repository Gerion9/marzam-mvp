/**
 * Materialized view of rolling sales aggregations per Marzam client.
 *
 * Marzam Execution Doc §9 mandates "Daily sales per pharmacy" + "Rolling 7/30-day
 * sales" + "Daily sales / daily target".  This MV pre-computes the heavy
 * groupings so the read endpoints (`/api/marzam/sales-summary`) stay snappy.
 *
 * Refresh strategy:
 *   - The bq-sync orchestrator calls `REFRESH MATERIALIZED VIEW CONCURRENTLY
 *     mv_pharmacy_sales_rollups` after `syncDailySales`.  CONCURRENTLY needs
 *     a UNIQUE index on the MV — added below as `mv_psr_client_unique`.
 *   - First refresh (during initial sync) cannot use CONCURRENTLY because the
 *     MV is empty; the orchestrator handles that.
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE MATERIALIZED VIEW mv_pharmacy_sales_rollups AS
    SELECT
      ds.marzam_client_id,
      MAX(ds.sale_date) AS last_sale_date,
      SUM(CASE WHEN ds.sale_date >= CURRENT_DATE - INTERVAL '7 days'  AND ds.sale_date <= CURRENT_DATE THEN ds.amount ELSE 0 END) AS sales_7d,
      SUM(CASE WHEN ds.sale_date >= CURRENT_DATE - INTERVAL '30 days' AND ds.sale_date <= CURRENT_DATE THEN ds.amount ELSE 0 END) AS sales_30d,
      SUM(CASE WHEN ds.sale_date = CURRENT_DATE THEN ds.amount ELSE 0 END) AS sales_today,
      SUM(CASE WHEN date_trunc('month', ds.sale_date) = date_trunc('month', CURRENT_DATE) THEN ds.amount ELSE 0 END) AS sales_mtd,
      COUNT(DISTINCT CASE WHEN ds.sale_date >= CURRENT_DATE - INTERVAL '30 days' AND ds.amount > 0 THEN ds.sale_date END) AS active_days_30d
    FROM daily_sales ds
    GROUP BY ds.marzam_client_id
    WITH NO DATA;
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX mv_psr_client_unique
      ON mv_pharmacy_sales_rollups (marzam_client_id);
  `);
  await knex.raw(`
    CREATE INDEX mv_psr_sales_30d
      ON mv_pharmacy_sales_rollups (sales_30d DESC);
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_pharmacy_sales_rollups;');
};
