/**
 * Documenta el schema esperado de visit_plans.metrics jsonb (no altera datos).
 *
 * Después de PR1-PR7 metrics contiene:
 *   {
 *     total_drive_minutes, total_service_minutes,
 *     caution_arcs, polyline_arcs,
 *     unassigned_count, assignments_count,
 *     last_leg_minutes_per_user: { [user_id]: minutes },
 *     coeffs_snapshot: { [user_id]: { source, alpha_duration, beta_distance, ... } },
 *     soft_window_violations, soft_window_violation_count,
 *     break_applied_per_user, break_skipped_per_user,
 *     solver: { strategy, tiers_seen, n_max_per_route, seeds_avg, runs },
 *     cost_breakdown: { fresh, cached, estimated_fallback, traffic_aware_used, polyline_in_matrix },
 *     balance: { swaps_attempted, swaps_accepted, gap_before, gap_after, gap_threshold_min, iterations },
 *     flags: { cost_coeffs, cap_validation, breaks, soft_windows, pareto_service, solver, inline_polyline, traffic_aware_publish, balance }
 *   }
 *
 * Reportes históricos (post-mortem.csv, dashboards de calidad de plan) usan
 * coeffs_snapshot para no contaminar datos antiguos cuando cambian los costs
 * en `cost_coefficients`.
 */

exports.up = async function up(knex) {
  await knex.raw(`
    COMMENT ON COLUMN visit_plans.metrics IS '{ total_drive_minutes, total_service_minutes, caution_arcs, polyline_arcs, unassigned_count, assignments_count, last_leg_minutes_per_user, coeffs_snapshot, soft_window_violations, break_applied_per_user, solver, cost_breakdown, balance, flags } — see migration 076 doc-block.';
  `);
};

exports.down = async function down(knex) {
  await knex.raw('COMMENT ON COLUMN visit_plans.metrics IS NULL;');
};
