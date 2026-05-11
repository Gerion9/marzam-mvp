/**
 * Cambio 3 — Empate cohabitantes + balance load-aware.
 *
 * When PLAN_LOAD_AWARE_TIEBREAK=true (and clusterByHome called with loadAwareTiebreak=true):
 *   - Ties (within epsKm=0.5 km of two centroids) resolve by:
 *       1. Current cluster load ASC (rep with fewer captured candidates wins)
 *       2. employee_code lexicographic ASC (deterministic final tiebreak)
 *   - tiebreakStats exposed: { tiebreaks_applied, by_load, by_employee_code }
 *
 * When the flag is OFF (legacy):
 *   - First centroid in array wins (arbitrary by rep order in DB).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { clusterByHome } = require('../../src/utils/kmeans');

// Two cohabitant reps (identical homes) — without tiebreak, the first in array wins all.
const COHABITANTS_2 = [
  { id: 'r1', home_lat: 19.40, home_lng: -99.10, employee_code: 'B999' },
  { id: 'r2', home_lat: 19.40, home_lng: -99.10, employee_code: 'A001' }, // earlier employee_code
];

// 4 candidates equidistant from the cohabitants (all at the same point around home).
const EQUIDIST_4 = [
  { id: 'c1', lat: 19.405, lng: -99.10 },
  { id: 'c2', lat: 19.406, lng: -99.10 },
  { id: 'c3', lat: 19.407, lng: -99.10 },
  { id: 'c4', lat: 19.408, lng: -99.10 },
];

test('Cambio 3 — flag OFF: array order wins ties (legacy, unbalanced)', () => {
  const { byRep } = clusterByHome(COHABITANTS_2, EQUIDIST_4, { loadAwareTiebreak: false });
  // Without tiebreak, all 4 should go to r1 (first in array) because both centroids
  // are at the same point — first match wins.
  const r1Count = byRep.get('r1').length;
  const r2Count = byRep.get('r2').length;
  assert.equal(r1Count, 4, `Legacy: r1 (first in array) gets all 4, got ${r1Count}`);
  assert.equal(r2Count, 0, `Legacy: r2 gets 0`);
});

test('Cambio 3 — flag ON: load-aware tiebreak balances 4 candidates 2-2', () => {
  const { byRep, tiebreakStats } = clusterByHome(COHABITANTS_2, EQUIDIST_4, { loadAwareTiebreak: true });
  const r1Count = byRep.get('r1').length;
  const r2Count = byRep.get('r2').length;
  assert.equal(r1Count + r2Count, 4, `All 4 candidates assigned`);
  // Balanced 2-2 (or close); difference at most 1.
  assert.ok(Math.abs(r1Count - r2Count) <= 1,
    `Tiebreak should balance: got ${r1Count} vs ${r2Count}`);
  // Telemetry should show tiebreaks fired.
  assert.ok(tiebreakStats.tiebreaks_applied > 0, `tiebreaks_applied should be >0, got ${tiebreakStats.tiebreaks_applied}`);
});

test('Cambio 3 — flag ON: employee_code breaks final ties when load is equal', () => {
  // With load 0-0 initially, first candidate goes to lower employee_code (A001 = r2).
  const { byRep } = clusterByHome(COHABITANTS_2, [EQUIDIST_4[0]], { loadAwareTiebreak: true });
  assert.equal(byRep.get('r2').length, 1, `Tied with 0 load: lower employee_code (r2 with A001) wins`);
  assert.equal(byRep.get('r1').length, 0);
});

test('Cambio 3 — 3 cohabitants + 9 candidates → 3-3-3', () => {
  const cohab3 = [
    { id: 'r1', home_lat: 19.40, home_lng: -99.10, employee_code: 'C003' },
    { id: 'r2', home_lat: 19.40, home_lng: -99.10, employee_code: 'A001' },
    { id: 'r3', home_lat: 19.40, home_lng: -99.10, employee_code: 'B002' },
  ];
  const candidates9 = [];
  for (let i = 0; i < 9; i += 1) {
    candidates9.push({ id: `c${i}`, lat: 19.405 + i * 0.0001, lng: -99.10 });
  }
  const { byRep } = clusterByHome(cohab3, candidates9, { loadAwareTiebreak: true });
  const counts = ['r1', 'r2', 'r3'].map((id) => byRep.get(id).length);
  // Each rep gets 3.
  assert.deepEqual(counts.sort(), [3, 3, 3], `3-3-3 split, got ${counts}`);
});

test('Cambio 3 — flag ON: well-separated clusters NOT affected by tiebreak', () => {
  // Two reps far apart should each capture their own cluster unaffected.
  const distantReps = [
    { id: 'r1', home_lat: 19.40, home_lng: -99.10, employee_code: 'A001' },
    { id: 'r2', home_lat: 19.60, home_lng: -99.10, employee_code: 'A002' },
  ];
  const stops = [
    { id: 'south1', lat: 19.405, lng: -99.10 },
    { id: 'south2', lat: 19.410, lng: -99.10 },
    { id: 'north1', lat: 19.595, lng: -99.10 },
    { id: 'north2', lat: 19.605, lng: -99.10 },
  ];
  const { byRep, tiebreakStats } = clusterByHome(distantReps, stops, { loadAwareTiebreak: true });
  assert.deepEqual(byRep.get('r1').map((c) => c.id).sort(), ['south1', 'south2']);
  assert.deepEqual(byRep.get('r2').map((c) => c.id).sort(), ['north1', 'north2']);
  // No tiebreak needed since distances are clearly different.
  assert.equal(tiebreakStats.tiebreaks_applied, 0,
    `No tiebreaks when clusters are well-separated, got ${tiebreakStats.tiebreaks_applied}`);
});

test('Cambio 3 — tiebreak_reasons split between by_load and by_employee_code', () => {
  const { tiebreakStats } = clusterByHome(COHABITANTS_2, EQUIDIST_4, { loadAwareTiebreak: true });
  const totalReasons = tiebreakStats.by_load + tiebreakStats.by_employee_code;
  assert.ok(totalReasons > 0, `At least one tiebreak reason should fire`);
  assert.ok(totalReasons <= tiebreakStats.tiebreaks_applied + 1,
    `Reason counts should be at most tiebreaks_applied: reasons=${totalReasons}, total=${tiebreakStats.tiebreaks_applied}`);
});

test('Cambio 3 — flag OFF: tiebreakStats still returned but always 0', () => {
  const { tiebreakStats } = clusterByHome(COHABITANTS_2, EQUIDIST_4, { loadAwareTiebreak: false });
  assert.equal(tiebreakStats.tiebreaks_applied, 0);
  assert.equal(tiebreakStats.by_load, 0);
  assert.equal(tiebreakStats.by_employee_code, 0);
});

test('Cambio 3 — deterministic across multiple invocations', () => {
  // Same input twice → identical output.
  const r1 = clusterByHome(COHABITANTS_2, EQUIDIST_4, { loadAwareTiebreak: true });
  const r2 = clusterByHome(COHABITANTS_2, EQUIDIST_4, { loadAwareTiebreak: true });
  const ids1 = r1.byRep.get('r1').map((c) => c.id).sort();
  const ids2 = r2.byRep.get('r1').map((c) => c.id).sort();
  assert.deepEqual(ids1, ids2, `Same input → same output`);
});
