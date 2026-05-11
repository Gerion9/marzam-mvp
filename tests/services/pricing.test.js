const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ESSENTIALS_TIERS,
  PRO_TIERS,
  piecewiseCost,
  freeTierRemaining,
  geocodingCost,
  routesEssentialsCost,
  routesProCost,
  routeOptimizationCost,
  naiveCost,
  geocodingNaiveCost,
  routesEssentialsNaiveCost,
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

test('routeOptimizationCost: shipments * $0.0013', () => {
  eq(routeOptimizationCost(0), 0);
  eq(routeOptimizationCost(1), 0.0013);
  eq(routeOptimizationCost(1000), 1.3);
  eq(routeOptimizationCost(100000), 130);
  eq(routeOptimizationCost(-1), 0);
  eq(routeOptimizationCost(NaN), 0);
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
