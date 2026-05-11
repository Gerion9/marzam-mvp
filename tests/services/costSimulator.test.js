const test = require('node:test');
const assert = require('node:assert/strict');

const { PRESETS, SUBSCRIPTIONS, simulateMonth } = require('../../src/services/costSimulator');

const eq = (actual, expected) => {
  assert.equal(actual, Math.round(expected * 100) / 100);
};

test('PRESETS exposes the 4 documented scenarios', () => {
  for (const k of ['pilot_ecatepec', 'sucursal_full', 'nacional', 'fleet_warning']) {
    assert.ok(PRESETS[k], `${k} preset missing`);
    assert.ok(PRESETS[k].label && PRESETS[k].description);
  }
});

test('SUBSCRIPTIONS lists Starter / Essentials / Pro with public USD figures', () => {
  assert.equal(SUBSCRIPTIONS.starter.monthly_usd, 100);
  assert.equal(SUBSCRIPTIONS.essentials.monthly_usd, 275);
  assert.equal(SUBSCRIPTIONS.pro.monthly_usd, 1200);
  // Pro deliberately does NOT include Single Vehicle (per Google docs).
  assert.equal(SUBSCRIPTIONS.pro.includes_single_opt, false);
  assert.equal(SUBSCRIPTIONS.starter.includes_single_opt, true);
});

test('simulateMonth (pilot_ecatepec, classic mode): under free tiers, ~$0', () => {
  const r = simulateMonth(PRESETS.pilot_ecatepec);
  // 10 × 22 × 23 = 5,060 shipments — classic mode means optimization is null.
  assert.equal(r.totals.total_shipments_per_month, 5060);
  assert.equal(r.route_optimization, null);
  // Geocoding 500 calls < 10k free → real $0.
  eq(r.geocoding.real_usd, 0);
  // Routes API: 40 plans/mes × 650 elements = 26_000 → 16k @ $5/1k = $80.
  assert.ok(r.routes_api.monthly_volume === 26000);
  eq(r.routes_api.real_usd, 80);
  // Naive: 26k × $5/1k = $130. Savings $50.
  eq(r.routes_api.naive_usd, 130);
  eq(r.routes_api.savings_usd, 50);
});

test('simulateMonth (sucursal_full, single_vehicle): crosses out of free tier', () => {
  const r = simulateMonth(PRESETS.sucursal_full);
  // 50 × 22 × 23 = 25,300 shipments
  assert.equal(r.totals.total_shipments_per_month, 25300);
  assert.equal(r.route_optimization.sku, 'single');
  // Single free 5k → 20.3k @ $10/1k = $203
  eq(r.route_optimization.real_usd, 203);
  // Naive: 25.3k × $10/1k = $253
  eq(r.route_optimization.naive_usd, 253);
  eq(r.route_optimization.savings_usd, 50);
  assert.equal(r.route_optimization.free_tier_remaining, 0);
});

test('simulateMonth (fleet_warning): same volume, ~3× more expensive than Single', () => {
  const single = simulateMonth({ ...PRESETS.sucursal_full, optimizer_mode: 'single_vehicle' });
  const fleet = simulateMonth({ ...PRESETS.sucursal_full, optimizer_mode: 'fleet' });
  assert.equal(single.totals.total_shipments_per_month, fleet.totals.total_shipments_per_month);
  // Single: 5k free + 20.3k @ $10 = $203. Fleet: 1k free + 24.3k @ $30 = $729.
  eq(single.route_optimization.real_usd, 203);
  eq(fleet.route_optimization.real_usd, 729);
  assert.ok(fleet.route_optimization.real_usd / single.route_optimization.real_usd >= 3);
});

test('simulateMonth (nacional, single_vehicle): crosses second tier boundary', () => {
  const r = simulateMonth(PRESETS.nacional);
  // 200 × 22 × 23 = 101,200 shipments
  assert.equal(r.totals.total_shipments_per_month, 101200);
  // 5k free + 95k @ $10 + 1.2k @ $4 = 950 + 4.8 = $954.80
  eq(r.route_optimization.real_usd, 954.8);
  // Naive: 101.2k × $10/1k = $1012
  eq(r.route_optimization.naive_usd, 1012);
});

test('simulateMonth: classic mode never carries an opt block (route_optimization is null)', () => {
  const r = simulateMonth({ ...PRESETS.pilot_ecatepec, optimizer_mode: 'classic' });
  assert.equal(r.route_optimization, null);
  // Grand total only mixes geocoding + routes_api.
  eq(r.grand_total.monthly_real_usd, r.geocoding.real_usd + r.routes_api.real_usd);
});

test('simulateMonth: invalid inputs are coerced to defensible defaults', () => {
  const r = simulateMonth({ reps: -5, working_days_per_month: 'twenty-two', optimizer_mode: 'bogus' });
  assert.equal(r.inputs.reps, 0);
  assert.equal(r.inputs.working_days_per_month, 22);
  assert.equal(r.inputs.optimizer_mode, 'classic');
  assert.equal(r.totals.total_shipments_per_month, 0);
});

test('simulateMonth: annual projection equals monthly * 12', () => {
  const r = simulateMonth(PRESETS.sucursal_full);
  eq(r.grand_total.annual_real_usd, r.grand_total.monthly_real_usd * 12);
  eq(r.grand_total.annual_naive_usd, r.grand_total.monthly_naive_usd * 12);
});

test('subscriptions: Fleet mode always falls outside the bundled plans', () => {
  const r = simulateMonth(PRESETS.fleet_warning);
  for (const sub of r.subscriptions) {
    assert.match(sub.notes || '', /Fleet.*aparte/);
  }
});

test('recommendation: critical level when Fleet mode is active', () => {
  const r = simulateMonth(PRESETS.fleet_warning);
  assert.equal(r.recommendation.level, 'critical');
  assert.match(r.recommendation.title, /Fleet/);
});

test('recommendation: info "operación gratuita" when everything fits in free tiers', () => {
  const r = simulateMonth({
    reps: 1, working_days_per_month: 1, stops_per_rep_per_day: 1,
    plans_per_month_per_rep: 1, optimizer_mode: 'classic',
    geocoding_calls_per_month: 0,
    routes_matrix_elements_per_plan: 10, routes_route_calls_per_plan: 0,
  });
  assert.equal(r.grand_total.monthly_real_usd, 0);
  assert.match(r.recommendation.title, /gratuita/);
});

test('Single Vehicle stays cheaper than Fleet at every shipment volume tested', () => {
  for (const reps of [10, 50, 100, 200, 500]) {
    const single = simulateMonth({
      ...PRESETS.sucursal_full, reps, optimizer_mode: 'single_vehicle',
    });
    const fleet = simulateMonth({
      ...PRESETS.sucursal_full, reps, optimizer_mode: 'fleet',
    });
    assert.ok(
      fleet.route_optimization.real_usd >= single.route_optimization.real_usd,
      `Fleet (${fleet.route_optimization.real_usd}) should be >= Single (${single.route_optimization.real_usd}) at reps=${reps}`,
    );
  }
});
