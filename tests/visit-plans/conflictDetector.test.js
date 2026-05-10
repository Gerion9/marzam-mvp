/**
 * conflictDetector pure-logic — classification + window overlap math.
 *
 * DB integration is exercised in scripts/smoke/smoke-plan-lifecycle.js
 * (Phase 6). These tests pin the conflict-type taxonomy and the date math.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { __classifyConflict, __overlapWindow } = require('../../src/modules/visit-plans/conflictDetector');

test('classify — weekly over monthly → weekly_overrides_monthly', () => {
  assert.equal(__classifyConflict('weekly', 'monthly'), 'weekly_overrides_monthly');
});

test('classify — daily over weekly → daily_overrides_weekly', () => {
  assert.equal(__classifyConflict('daily', 'weekly'), 'daily_overrides_weekly');
});

test('classify — daily over monthly → daily_overrides_monthly', () => {
  assert.equal(__classifyConflict('daily', 'monthly'), 'daily_overrides_monthly');
});

test('classify — any other combination → custom_overlap', () => {
  assert.equal(__classifyConflict('monthly', 'weekly'), 'custom_overlap'); // unusual but possible
  assert.equal(__classifyConflict('weekly', 'daily'), 'custom_overlap');
  assert.equal(__classifyConflict('monthly', 'monthly'), 'custom_overlap');
  assert.equal(__classifyConflict('weekly', 'weekly'), 'custom_overlap');
});

test('overlap — full containment (weekly inside monthly)', () => {
  const monthly = { period_start: '2026-05-01', period_end: '2026-05-31' };
  const weekly = { period_start: '2026-05-11', period_end: '2026-05-15' };
  assert.deepEqual(
    __overlapWindow(weekly, monthly),
    { start: '2026-05-11', end: '2026-05-15' },
  );
});

test('overlap — partial (weekly straddles monthly end)', () => {
  const monthly = { period_start: '2026-05-01', period_end: '2026-05-31' };
  const weekly = { period_start: '2026-05-29', period_end: '2026-06-05' };
  assert.deepEqual(
    __overlapWindow(weekly, monthly),
    { start: '2026-05-29', end: '2026-05-31' },
  );
});

test('overlap — adjacent windows (no shared day) → null', () => {
  const a = { period_start: '2026-05-01', period_end: '2026-05-10' };
  const b = { period_start: '2026-05-11', period_end: '2026-05-20' };
  assert.equal(__overlapWindow(a, b), null);
});

test('overlap — identical windows → identical window returned', () => {
  const a = { period_start: '2026-05-01', period_end: '2026-05-31' };
  const b = { period_start: '2026-05-01', period_end: '2026-05-31' };
  assert.deepEqual(
    __overlapWindow(a, b),
    { start: '2026-05-01', end: '2026-05-31' },
  );
});

test('overlap — single shared day', () => {
  const a = { period_start: '2026-05-01', period_end: '2026-05-15' };
  const b = { period_start: '2026-05-15', period_end: '2026-05-31' };
  assert.deepEqual(
    __overlapWindow(a, b),
    { start: '2026-05-15', end: '2026-05-15' },
  );
});

test('overlap — order independence (a,b vs b,a returns same window)', () => {
  const a = { period_start: '2026-05-01', period_end: '2026-05-31' };
  const b = { period_start: '2026-05-11', period_end: '2026-05-15' };
  assert.deepEqual(__overlapWindow(a, b), __overlapWindow(b, a));
});
