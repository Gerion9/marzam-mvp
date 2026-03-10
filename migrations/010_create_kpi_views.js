/**
 * Materialized views for MVP KPI dashboard.
 * Refreshed on demand or via scheduled job.
 */
exports.up = async function (knex) {
  // Overall pharmacy funnel
  await knex.raw(`
    CREATE MATERIALIZED VIEW mv_pharmacy_funnel AS
    SELECT
      count(*)                                                         AS total_pharmacies,
      count(*) FILTER (WHERE assigned_rep_id IS NOT NULL)              AS assigned,
      count(*) FILTER (WHERE last_visited_at IS NOT NULL)              AS visited,
      count(*) FILTER (WHERE last_visit_outcome = 'interested')        AS interested,
      count(*) FILTER (WHERE last_visit_outcome = 'needs_follow_up')   AS needs_follow_up,
      count(*) FILTER (WHERE status IN ('closed','invalid','duplicate','moved')) AS invalid_closed,
      count(*) FILTER (WHERE last_visit_outcome = 'contact_made')      AS contact_made
    FROM pharmacies
    WHERE is_independent = true;
  `);

  // Per-rep productivity
  await knex.raw(`
    CREATE MATERIALIZED VIEW mv_rep_productivity AS
    SELECT
      u.id                        AS rep_id,
      u.full_name                 AS rep_name,
      count(DISTINCT vr.id)       AS total_visits,
      count(DISTINCT vr.pharmacy_id) AS unique_pharmacies_visited,
      count(*) FILTER (WHERE vr.outcome = 'interested')   AS interested_count,
      count(*) FILTER (WHERE vr.outcome = 'needs_follow_up') AS follow_up_count,
      min(vr.created_at)          AS first_visit,
      max(vr.created_at)          AS last_visit
    FROM users u
    LEFT JOIN visit_reports vr ON vr.rep_id = u.id
    WHERE u.role = 'field_rep'
    GROUP BY u.id, u.full_name;
  `);

  // Coverage by municipality
  await knex.raw(`
    CREATE MATERIALIZED VIEW mv_coverage_by_municipality AS
    SELECT
      municipality,
      count(*)                                             AS total,
      count(*) FILTER (WHERE last_visited_at IS NOT NULL)  AS visited,
      count(*) FILTER (WHERE assigned_rep_id IS NOT NULL)  AS assigned,
      ROUND(
        100.0 * count(*) FILTER (WHERE last_visited_at IS NOT NULL) / NULLIF(count(*), 0),
        1
      ) AS visit_pct
    FROM pharmacies
    WHERE is_independent = true AND municipality IS NOT NULL
    GROUP BY municipality
    ORDER BY total DESC;
  `);

  // Assignment progress summary
  await knex.raw(`
    CREATE MATERIALIZED VIEW mv_assignment_progress AS
    SELECT
      ta.id                       AS assignment_id,
      ta.status                   AS assignment_status,
      ta.campaign_objective,
      ta.rep_id,
      u.full_name                 AS rep_name,
      count(s.id)                 AS total_stops,
      count(s.id) FILTER (WHERE s.stop_status = 'completed') AS completed_stops,
      ROUND(
        100.0 * count(s.id) FILTER (WHERE s.stop_status = 'completed') / NULLIF(count(s.id), 0),
        1
      ) AS completion_pct,
      ta.due_date,
      ta.created_at
    FROM territory_assignments ta
    LEFT JOIN assignment_stops s ON s.assignment_id = ta.id
    LEFT JOIN users u ON u.id = ta.rep_id
    GROUP BY ta.id, ta.status, ta.campaign_objective, ta.rep_id, u.full_name, ta.due_date, ta.created_at;
  `);

  // Potential sales aggregation
  await knex.raw(`
    CREATE MATERIALIZED VIEW mv_potential_sales AS
    SELECT
      coalesce(sum(potential_sales), 0)                                  AS total_potential,
      coalesce(sum(potential_sales) FILTER (WHERE status = 'converted'), 0) AS converted_sales,
      count(*)                                                           AS total_leads,
      count(*) FILTER (WHERE status = 'interested')                      AS interested_leads,
      count(*) FILTER (WHERE status = 'follow_up_required')              AS follow_up_leads
    FROM commercial_leads;
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_potential_sales');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_assignment_progress');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_coverage_by_municipality');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_rep_productivity');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_pharmacy_funnel');
};
