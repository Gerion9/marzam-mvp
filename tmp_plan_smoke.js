// Smoke test: previewGenerate with flags OFF and ON. Now uses real
// classifyCandidatesByPolygon (the readCache + levelAtPoints binding bug
// was fixed in this same PR series).

(async () => {
  const planGenerator = require('./src/modules/visit-plans/planGenerator');

  const REP_ID = '6e0a73d7-8d76-49c4-a6fc-bd14a503faef';
  const baseArgs = {
    ownerUserId: REP_ID,
    scopeUserIds: [REP_ID],
    granularity: 'weekly',
    periodStart: '2026-05-04',
    periodEnd: '2026-05-08',
    paretoFilter: ['A', 'B', 'C'],
    routeStartHHMM: '08:00',
  };

  for (const flag of ['PLAN_USE_COST_COEFFS', 'PLAN_ENABLE_CAP_VALIDATION',
    'PLAN_ENABLE_BREAKS', 'PLAN_ENABLE_SOFT_WINDOWS', 'PLAN_ENABLE_PARETO_SERVICE',
    'PLAN_ENABLE_BALANCE', 'ROUTES_INLINE_POLYLINE', 'PLAN_TRAFFIC_AWARE']) {
    delete process.env[flag];
  }
  process.env.PLAN_SOLVER = 'legacy';

  console.log('=== Run #1: legacy (flags OFF) ===');
  const t0 = Date.now();
  const r1 = await planGenerator.previewGenerate(baseArgs);
  console.log(`  elapsed: ${Date.now() - t0}ms`);
  console.log('  assignments_count:', r1.metrics.assignments_count);
  console.log('  total_drive_minutes:', r1.metrics.total_drive_minutes);
  console.log('  flags:', JSON.stringify(r1.metrics.flags));
  console.log('  solver:', JSON.stringify(r1.metrics.solver));
  console.log('  cost_breakdown:', JSON.stringify(r1.metrics.cost_breakdown));

  console.log('\n=== Run #2: ALL flags ON (no traffic-aware/inline-polyline) ===');
  process.env.PLAN_USE_COST_COEFFS = 'true';
  process.env.PLAN_ENABLE_CAP_VALIDATION = 'true';
  process.env.PLAN_ENABLE_BREAKS = 'true';
  process.env.PLAN_ENABLE_SOFT_WINDOWS = 'true';
  process.env.PLAN_ENABLE_PARETO_SERVICE = 'true';
  process.env.PLAN_ENABLE_BALANCE = 'true';
  process.env.PLAN_SOLVER = 'multistart';
  delete require.cache[require.resolve('./src/modules/visit-plans/planGenerator')];
  delete require.cache[require.resolve('./src/services/routesMatrix')];
  const pg2 = require('./src/modules/visit-plans/planGenerator');
  const t1 = Date.now();
  const r2 = await pg2.previewGenerate(baseArgs);
  console.log(`  elapsed: ${Date.now() - t1}ms`);
  console.log('  assignments_count:', r2.metrics.assignments_count);
  console.log('  total_drive_minutes:', r2.metrics.total_drive_minutes);
  console.log('  flags:', JSON.stringify(r2.metrics.flags));
  console.log('  solver:', JSON.stringify(r2.metrics.solver));
  console.log('  balance:', JSON.stringify(r2.metrics.balance));
  console.log('  cost_breakdown:', JSON.stringify(r2.metrics.cost_breakdown));
  console.log('  break_applied_per_user:', JSON.stringify(r2.metrics.break_applied_per_user));
  console.log('  soft_window_violations:', r2.metrics.soft_window_violations);

  let pass = 0, fail = 0;
  function check(cond, desc) { if (cond) { pass++; console.log('PASS ' + desc); } else { fail++; console.log('FAIL ' + desc); } }

  console.log('\n=== Assertions ===');
  check(r1.metrics.flags.cost_coeffs === false, 'legacy: cost_coeffs flag false');
  check(r1.metrics.flags.solver === 'legacy', 'legacy: solver = legacy');
  check(r2.metrics.flags.cost_coeffs === true, 'all-on: cost_coeffs flag true');
  check(r2.metrics.flags.solver === 'multistart', 'all-on: solver = multistart');
  check(r2.metrics.flags.balance === true, 'all-on: balance flag true');
  check(r2.metrics.balance.enabled === true, 'all-on: balance.enabled true');
  check(r1.metrics.balance.enabled === false, 'legacy: balance.enabled false');
  if (r2.metrics.coeffs_snapshot && Object.keys(r2.metrics.coeffs_snapshot).length > 0) {
    const first = Object.values(r2.metrics.coeffs_snapshot)[0];
    check(first?.source === 'global', 'all-on: coeff source = global');
  } else check(false, 'all-on: coeffs_snapshot populated');
  // Solver actually ran
  if (r2.metrics.assignments_count > 0) {
    check(r2.metrics.solver.runs > 0, `solver ran (runs=${r2.metrics.solver.runs})`);
    check(r2.metrics.solver.n_max_per_route > 0, `n_max_per_route > 0 (got ${r2.metrics.solver.n_max_per_route})`);
  } else {
    console.log('  (no assignments generated — rep has no targets configured for this week; structural metrics are still tested)');
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
