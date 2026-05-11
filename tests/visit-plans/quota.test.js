const test = require('node:test');
const assert = require('node:assert/strict');

const branchPlanSettings = require('../../src/services/branchPlanSettings');
const service = require('../../src/modules/visit-plans/visitPlans.service');

const compute = service.__computeQuotaResult;

test('default quota in DEFAULTS is 3 plans/day', () => {
  assert.equal(branchPlanSettings.DEFAULTS.daily_plans_limit, 3);
});

test('__validate: accepts daily_plans_limit ≥ 0, clamps malformed values to default', () => {
  const v = branchPlanSettings.__validate;
  // Accepted values are merged onto the default block.
  assert.equal(v({ daily_plans_limit: 5 }).daily_plans_limit, 5);
  assert.equal(v({ daily_plans_limit: 0 }).daily_plans_limit, 0);
  assert.equal(v({ daily_plans_limit: 1 }).daily_plans_limit, 1);
  // Unknown / wrong-type → default.
  assert.equal(v({ daily_plans_limit: 'three' }).daily_plans_limit, 3);
  assert.equal(v({ daily_plans_limit: null }).daily_plans_limit, 3);
  assert.equal(v({ daily_plans_limit: undefined }).daily_plans_limit, 3);
  assert.equal(v({}).daily_plans_limit, 3);
});

test('__validate: rejects out-of-range daily_plans_limit (negative / huge)', () => {
  const v = branchPlanSettings.__validate;
  assert.equal(v({ daily_plans_limit: -1 }).daily_plans_limit, 3);
  assert.equal(v({ daily_plans_limit: branchPlanSettings.MAX_DAILY_PLANS_LIMIT + 1 }).daily_plans_limit, 3);
  // Exactly at the cap is allowed.
  assert.equal(v({ daily_plans_limit: branchPlanSettings.MAX_DAILY_PLANS_LIMIT }).daily_plans_limit, branchPlanSettings.MAX_DAILY_PLANS_LIMIT);
});

test('__validate: floors decimal limits', () => {
  const v = branchPlanSettings.__validate;
  assert.equal(v({ daily_plans_limit: 3.9 }).daily_plans_limit, 3);
  assert.equal(v({ daily_plans_limit: 0.1 }).daily_plans_limit, 0);
});

test('computeQuotaResult: 0 used of 3 → remaining 3, not exceeded', () => {
  const r = compute({ limit: 3, used: 0 });
  assert.equal(r.daily_limit, 3);
  assert.equal(r.used_today, 0);
  assert.equal(r.remaining, 3);
  assert.equal(r.exceeded, false);
});

test('computeQuotaResult: 3 used of 3 → remaining 0, exceeded true', () => {
  const r = compute({ limit: 3, used: 3 });
  assert.equal(r.remaining, 0);
  assert.equal(r.exceeded, true);
});

test('computeQuotaResult: 4 used of 3 → remaining 0, exceeded true (no negatives)', () => {
  const r = compute({ limit: 3, used: 4 });
  assert.equal(r.remaining, 0);
  assert.equal(r.exceeded, true);
});

test('computeQuotaResult: limit 0 → always exceeded', () => {
  const r0 = compute({ limit: 0, used: 0 });
  assert.equal(r0.exceeded, true);
  assert.equal(r0.remaining, 0);
  assert.ok(r0._hint.includes('cuota deshabilitada') || r0._hint.includes('admin'));
});

test('computeQuotaResult: clamps negative used/limit to 0', () => {
  const r = compute({ limit: -5, used: -2 });
  assert.equal(r.daily_limit, 0);
  assert.equal(r.used_today, 0);
});

test('computeQuotaResult: reset_at is ISO string of next UTC midnight', () => {
  const now = new Date(Date.UTC(2026, 4, 10, 18, 30, 0)); // 2026-05-10T18:30:00Z
  const r = compute({ limit: 3, used: 1, now });
  assert.equal(r.reset_at, '2026-05-11T00:00:00.000Z');
});

test('computeQuotaResult: reset_at rolls over December 31 → January 1', () => {
  const now = new Date(Date.UTC(2026, 11, 31, 23, 59, 0)); // 2026-12-31T23:59:00Z
  const r = compute({ limit: 3, used: 0, now });
  assert.equal(r.reset_at, '2027-01-01T00:00:00.000Z');
});

test('controller / service surface exports getRemainingPlanQuota + quota handler', () => {
  // Structural test — guarda contra rename / drop accidentales.
  assert.equal(typeof service.getRemainingPlanQuota, 'function');
  const controller = require('../../src/modules/visit-plans/visitPlans.controller');
  assert.equal(typeof controller.quota, 'function');
  assert.equal(typeof controller.create, 'function');
});

test('routes/visitPlans.routes registers GET /quota and POST / with manager gate', () => {
  const router = require('../../src/modules/visit-plans/visitPlans.routes');
  const hasQuota = router.stack.some((l) => l.route?.path === '/quota' && l.route.methods.get);
  assert.equal(hasQuota, true);
  const post = router.stack.find((l) => l.route?.path === '/' && l.route.methods.post);
  assert.ok(post, 'POST / must be registered');
  // POST / debe estar protegido por authorize (al menos 2 capas además de la
  // route handler: authenticate + authorize).
  assert.ok(post.route.stack.length >= 3, 'POST / must run through authenticate+authorize before controller.create');
});
