const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ESSENTIALS_TIERS,
  PRO_TIERS,
  OPTIMIZATION_SINGLE_TIERS,
  OPTIMIZATION_FLEET_TIERS,
  piecewiseCost,
  freeTierRemaining,
  geocodingCost,
  routesEssentialsCost,
  routesProCost,
  routeOptimizationCost,
  routeOptimizationIncrementalCost,
  classifyOptimizationSku,
  naiveCost,
  geocodingNaiveCost,
  routesEssentialsNaiveCost,
  enrich,
} = require('../../src/services/pricing');

// Helper: float-tolerant equality at 4 decimals.
const eq = (actual, expected) => {
  assert.equal(actual, Math.round(expected * 10000) / 10000);
};

test('piecewiseCost: volume 0 → $0', () => {
  eq(piecewiseCost(0, ESSENTIALS_TIERS), 0);
  eq(piecewiseCost(0, PRO_TIERS), 0);
});

test('piecewiseCost: free tier boundary 9_999 → $0 (still inside free)', () => {
  eq(piecewiseCost(9999, ESSENTIALS_TIERS), 0);
});

test('piecewiseCost: free tier exhaustion at exactly 10_000 → $0', () => {
  eq(piecewiseCost(10000, ESSENTIALS_TIERS), 0);
});

test('piecewiseCost: 10_001 → 1 element at $5/1k = $0.005', () => {
  eq(piecewiseCost(10001, ESSENTIALS_TIERS), 0.005);
});

test('piecewiseCost: 99_999 → 89_999 @ $5/1k = $449.995', () => {
  eq(piecewiseCost(99999, ESSENTIALS_TIERS), 449.995);
});

test('piecewiseCost: 100_000 → 90_000 @ $5/1k = $450 exact', () => {
  eq(piecewiseCost(100000, ESSENTIALS_TIERS), 450);
});

test('piecewiseCost: 100_001 → $450 + 1 @ $4/1k = $450.004', () => {
  eq(piecewiseCost(100001, ESSENTIALS_TIERS), 450.004);
});

test('piecewiseCost: 500_000 → $450 + 400_000 @ $4/1k = $2050', () => {
  eq(piecewiseCost(500000, ESSENTIALS_TIERS), 2050);
});

test('piecewiseCost: 1_000_000 → $2050 + 500_000 @ $3/1k = $3550', () => {
  eq(piecewiseCost(1000000, ESSENTIALS_TIERS), 3550);
});

test('piecewiseCost: 1_500_000 → $3550 + 500_000 @ $1.5/1k = $4300', () => {
  eq(piecewiseCost(1500000, ESSENTIALS_TIERS), 4300);
});

test('piecewiseCost (Pro): free tier is half (5k), $10/1k start, $3/1k cap', () => {
  eq(piecewiseCost(5000, PRO_TIERS), 0);
  eq(piecewiseCost(5001, PRO_TIERS), 0.01); // 1 @ $10/1k
  eq(piecewiseCost(100000, PRO_TIERS), 950); // 95_000 @ $10/1k
  eq(piecewiseCost(500000, PRO_TIERS), 950 + 400000 * 0.008); // = $4150
  eq(piecewiseCost(1000000, PRO_TIERS), 4150 + 500000 * 0.006); // = $7150
  eq(piecewiseCost(2000000, PRO_TIERS), 7150 + 1000000 * 0.003); // = $10150
});

test('piecewiseCost: negative/NaN/null → $0', () => {
  eq(piecewiseCost(-1, ESSENTIALS_TIERS), 0);
  eq(piecewiseCost(NaN, ESSENTIALS_TIERS), 0);
  eq(piecewiseCost(null, ESSENTIALS_TIERS), 0);
  eq(piecewiseCost(undefined, ESSENTIALS_TIERS), 0);
});

test('freeTierRemaining: returns remaining elements before paid bands start', () => {
  assert.equal(freeTierRemaining(0, ESSENTIALS_TIERS), 10000);
  assert.equal(freeTierRemaining(5000, ESSENTIALS_TIERS), 5000);
  assert.equal(freeTierRemaining(9999, ESSENTIALS_TIERS), 1);
  assert.equal(freeTierRemaining(10000, ESSENTIALS_TIERS), 0);
  assert.equal(freeTierRemaining(20000, ESSENTIALS_TIERS), 0);
  assert.equal(freeTierRemaining(0, PRO_TIERS), 5000);
  assert.equal(freeTierRemaining(2500, PRO_TIERS), 2500);
  assert.equal(freeTierRemaining(5000, PRO_TIERS), 0);
});

test('freeTierRemaining: negative volume treated as 0', () => {
  assert.equal(freeTierRemaining(-100, ESSENTIALS_TIERS), 10000);
});

test('freeTierRemaining: table without free band returns Infinity', () => {
  const paidOnly = [{ upTo: 100, pricePerK: 5 }, { upTo: Infinity, pricePerK: 3 }];
  assert.equal(freeTierRemaining(0, paidOnly), Infinity);
});

test('geocodingCost / routesEssentialsCost == piecewiseCost(ESSENTIALS)', () => {
  for (const v of [0, 10000, 100000, 250000, 1500000]) {
    eq(geocodingCost(v), piecewiseCost(v, ESSENTIALS_TIERS));
    eq(routesEssentialsCost(v), piecewiseCost(v, ESSENTIALS_TIERS));
  }
});

test('routesProCost == piecewiseCost(PRO)', () => {
  for (const v of [0, 5000, 100000, 750000, 2000000]) {
    eq(routesProCost(v), piecewiseCost(v, PRO_TIERS));
  }
});

test('classifyOptimizationSku: 1 vehicle → single; 2+ → fleet', () => {
  assert.equal(classifyOptimizationSku(0), 'single');
  assert.equal(classifyOptimizationSku(1), 'single');
  assert.equal(classifyOptimizationSku(2), 'fleet');
  assert.equal(classifyOptimizationSku(50), 'fleet');
});

test('routeOptimizationCost (single, Pro): free tier 5k, then $10/1k', () => {
  eq(routeOptimizationCost(0, { kind: 'single' }), 0);
  eq(routeOptimizationCost(5000, { kind: 'single' }), 0);                 // still free
  eq(routeOptimizationCost(5001, { kind: 'single' }), 0.01);              // 1 @ $10/1k
  eq(routeOptimizationCost(100000, { kind: 'single' }), 950);             // 95k @ $10/1k
  eq(routeOptimizationCost(500000, { kind: 'single' }), 950 + 400000 * 0.004);    // = $2550
  eq(routeOptimizationCost(1000000, { kind: 'single' }), 2550 + 500000 * 0.002);  // = $3550
});

test('routeOptimizationCost (fleet, Enterprise): tighter 1k free, then $30/1k', () => {
  eq(routeOptimizationCost(0, { kind: 'fleet' }), 0);
  eq(routeOptimizationCost(1000, { kind: 'fleet' }), 0);
  eq(routeOptimizationCost(1001, { kind: 'fleet' }), 0.03);               // 1 @ $30/1k
  eq(routeOptimizationCost(100000, { kind: 'fleet' }), 99000 * 0.03);     // = $2970
  eq(routeOptimizationCost(500000, { kind: 'fleet' }), 2970 + 400000 * 0.014);   // = $8570
  eq(routeOptimizationCost(1000000, { kind: 'fleet' }), 8570 + 500000 * 0.006);  // = $11570
});

test('routeOptimizationCost: default kind is single', () => {
  eq(routeOptimizationCost(5001), 0.01);
  eq(routeOptimizationCost(5001, {}), 0.01);
});

test('routeOptimizationCost: negative/NaN/null → 0 for both SKUs', () => {
  eq(routeOptimizationCost(-1, { kind: 'single' }), 0);
  eq(routeOptimizationCost(NaN, { kind: 'fleet' }), 0);
  eq(routeOptimizationCost(null, { kind: 'fleet' }), 0);
});

test('routeOptimizationIncrementalCost: respects tier boundary crossings', () => {
  // 4_999 → 5_001: only 1 shipment crosses out of free.
  eq(routeOptimizationIncrementalCost({ shipments: 2, currentMonthlyVolume: 4999, kind: 'single' }), 0.01);
  // Exactly at boundary: cross 5_000 → 6_000 = 1_000 at $10/1k = $10.
  eq(routeOptimizationIncrementalCost({ shipments: 1000, currentMonthlyVolume: 5000, kind: 'single' }), 10);
  // Spans two tiers: 99_500 → 101_000 = 500 @ $10/1k + 1000 @ $4/1k.
  eq(routeOptimizationIncrementalCost({ shipments: 1500, currentMonthlyVolume: 99500, kind: 'single' }),
    500 * 0.01 + 1000 * 0.004);
  // Fleet inside the $30/1k tier: simple linear within band.
  eq(routeOptimizationIncrementalCost({ shipments: 100, currentMonthlyVolume: 50000, kind: 'fleet' }), 100 * 0.03);
  // Fleet free tier exhaustion: 999 → 1001 → 1 unit beyond free.
  eq(routeOptimizationIncrementalCost({ shipments: 2, currentMonthlyVolume: 999, kind: 'fleet' }), 0.03);
});

test('routeOptimizationIncrementalCost: invalid inputs → 0', () => {
  eq(routeOptimizationIncrementalCost({ shipments: 0, currentMonthlyVolume: 100, kind: 'single' }), 0);
  eq(routeOptimizationIncrementalCost({ shipments: -5, currentMonthlyVolume: 100, kind: 'single' }), 0);
  eq(routeOptimizationIncrementalCost({ shipments: NaN, currentMonthlyVolume: 100, kind: 'fleet' }), 0);
});

test('Fleet vs Single: same volume is 3x to 5x more expensive on Fleet', () => {
  // The whole point of the SKU split: never let a casual 2-vehicle test
  // payload accidentally trip the Enterprise tier.
  const v = 50000;
  const single = routeOptimizationCost(v, { kind: 'single' });
  const fleet = routeOptimizationCost(v, { kind: 'fleet' });
  // Single: 5k free + 45k @ $10 = $450; Fleet: 1k free + 49k @ $30 = $1470.
  eq(single, 450);
  eq(fleet, 1470);
  assert.ok(fleet / single >= 3);
});

test('OPTIMIZATION_*_TIERS exported with documented free-tier boundaries', () => {
  assert.equal(OPTIMIZATION_SINGLE_TIERS[0].upTo, 5000);
  assert.equal(OPTIMIZATION_SINGLE_TIERS[0].pricePerK, 0);
  assert.equal(OPTIMIZATION_FLEET_TIERS[0].upTo, 1000);
  assert.equal(OPTIMIZATION_FLEET_TIERS[0].pricePerK, 0);
  // Bottom-of-curve asymptote ratios from the public docs.
  const singleAsymptote = OPTIMIZATION_SINGLE_TIERS[OPTIMIZATION_SINGLE_TIERS.length - 1].pricePerK;
  const fleetAsymptote = OPTIMIZATION_FLEET_TIERS[OPTIMIZATION_FLEET_TIERS.length - 1].pricePerK;
  eq(singleAsymptote, 0.7);
  eq(fleetAsymptote, 2.1);
});

test('naiveCost: ignores free tier and tier degradation', () => {
  // 9999 → $0 piecewise (free), but linear = 9999 * $5/1k = $49.995.
  eq(naiveCost(9999, ESSENTIALS_TIERS), 49.995);
  // 1_000_000 piecewise = $3550, naive = 1_000_000 * $5/1k = $5000.
  eq(naiveCost(1000000, ESSENTIALS_TIERS), 5000);
  // Pro: 5_000 piecewise = $0, naive = 5_000 * $10/1k = $50.
  eq(naiveCost(5000, PRO_TIERS), 50);
});

test('savings = naive - piecewise is always non-negative', () => {
  for (const v of [0, 1, 10000, 50000, 100000, 999999, 1000000, 5000000]) {
    const piecewise = piecewiseCost(v, ESSENTIALS_TIERS);
    const naive = naiveCost(v, ESSENTIALS_TIERS);
    assert.ok(naive >= piecewise, `naive ${naive} should be >= piecewise ${piecewise} for vol ${v}`);
  }
});

test('geocodingNaiveCost / routesEssentialsNaiveCost match naiveCost(ESSENTIALS)', () => {
  for (const v of [10000, 100000, 1000000]) {
    eq(geocodingNaiveCost(v), naiveCost(v, ESSENTIALS_TIERS));
    eq(routesEssentialsNaiveCost(v), naiveCost(v, ESSENTIALS_TIERS));
  }
});

test('enrich: returns the expected block shape (essentials default)', () => {
  const b = enrich(50000);
  assert.equal(b.tier, 'essentials');
  // 50k: 10k free + 40k @ $5/1k = $200
  eq(b.est_cost_real_usd, 200);
  // naive: 50k * $5/1k = $250
  eq(b.est_cost_naive_usd, 250);
  eq(b.est_savings_vs_naive, 50);
  assert.equal(b.free_tier_remaining, 0);
});

test('enrich: pro tier honored', () => {
  const b = enrich(50000, { tier: 'pro' });
  assert.equal(b.tier, 'pro');
  // 5k free + 45k @ $10/1k = $450
  eq(b.est_cost_real_usd, 450);
  // naive: 50k * $10/1k = $500
  eq(b.est_cost_naive_usd, 500);
  eq(b.est_savings_vs_naive, 50);
  assert.equal(b.free_tier_remaining, 0);
});

test('enrich: free-tier headroom surfaces remaining elements, savings ≥ 0', () => {
  const b = enrich(2500);
  assert.equal(b.free_tier_remaining, 7500);
  eq(b.est_cost_real_usd, 0);
  // naive treats 2500 elements at base rate, so savings = naive cost.
  eq(b.est_cost_naive_usd, 12.5);
  eq(b.est_savings_vs_naive, 12.5);
  assert.ok(b.est_savings_vs_naive >= 0);
});

test('enrich: volume 0 → zeroed savings and full free-tier headroom', () => {
  const b = enrich(0);
  eq(b.est_cost_real_usd, 0);
  eq(b.est_cost_naive_usd, 0);
  eq(b.est_savings_vs_naive, 0);
  assert.equal(b.free_tier_remaining, 10000);
});
