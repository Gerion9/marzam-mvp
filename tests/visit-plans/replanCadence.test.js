/**
 * Cadence exclusion logic for replanWithHistory.
 *
 * Pure unit tests of `shouldExclude`. DB-touching tests live in the smoke
 * scripts (scripts/smoke/smoke-plan-lifecycle.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { __shouldExclude, CADENCE_EXCLUSION_DAYS } = require('../../src/modules/visit-plans/replanWithHistory');

const NOW = new Date('2026-05-10T12:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

test('cadence windows match Marzam Execution Doc (A=7, B=14, C=30, D=60)', () => {
  assert.equal(CADENCE_EXCLUSION_DAYS.A, 7);
  assert.equal(CADENCE_EXCLUSION_DAYS.B, 14);
  assert.equal(CADENCE_EXCLUSION_DAYS.C, 30);
  assert.equal(CADENCE_EXCLUSION_DAYS.D, 60);
});

test('Pareto A (weekly) — exclude if visited within 7 days', () => {
  // Visited 3 days ago → excluded.
  assert.equal(__shouldExclude({ pareto: 'A', lastVisitedAt: daysAgo(3), now: NOW }), true);
  // Visited 6.5 days ago → still excluded (just under window).
  assert.equal(__shouldExclude({ pareto: 'A', lastVisitedAt: daysAgo(6.5), now: NOW }), true);
  // Visited 7 days ago → NOT excluded (boundary: ageDays >= window).
  assert.equal(__shouldExclude({ pareto: 'A', lastVisitedAt: daysAgo(7), now: NOW }), false);
  // Visited 10 days ago → not excluded.
  assert.equal(__shouldExclude({ pareto: 'A', lastVisitedAt: daysAgo(10), now: NOW }), false);
});

test('Pareto B (bi-weekly) — exclude within 14 days', () => {
  assert.equal(__shouldExclude({ pareto: 'B', lastVisitedAt: daysAgo(7), now: NOW }), true);
  assert.equal(__shouldExclude({ pareto: 'B', lastVisitedAt: daysAgo(13.5), now: NOW }), true);
  assert.equal(__shouldExclude({ pareto: 'B', lastVisitedAt: daysAgo(15), now: NOW }), false);
});

test('Pareto C (monthly) — exclude within 30 days', () => {
  assert.equal(__shouldExclude({ pareto: 'C', lastVisitedAt: daysAgo(20), now: NOW }), true);
  assert.equal(__shouldExclude({ pareto: 'C', lastVisitedAt: daysAgo(45), now: NOW }), false);
});

test('Pareto D (bi-monthly prospects) — exclude within 60 days', () => {
  assert.equal(__shouldExclude({ pareto: 'D', lastVisitedAt: daysAgo(45), now: NOW }), true);
  assert.equal(__shouldExclude({ pareto: 'D', lastVisitedAt: daysAgo(75), now: NOW }), false);
});

test('no lastVisitedAt → never excluded (new pharmacy or never visited)', () => {
  for (const pareto of ['A', 'B', 'C', 'D']) {
    assert.equal(__shouldExclude({ pareto, lastVisitedAt: null, now: NOW }), false);
    assert.equal(__shouldExclude({ pareto, lastVisitedAt: undefined, now: NOW }), false);
  }
});

test('unknown pareto → never excluded (defensive, do not over-exclude)', () => {
  assert.equal(__shouldExclude({ pareto: 'Z', lastVisitedAt: daysAgo(1), now: NOW }), false);
  assert.equal(__shouldExclude({ pareto: null, lastVisitedAt: daysAgo(1), now: NOW }), false);
  assert.equal(__shouldExclude({ pareto: undefined, lastVisitedAt: daysAgo(1), now: NOW }), false);
});
