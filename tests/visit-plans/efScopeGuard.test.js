/**
 * Cambio 1 — EF scope guard + national estimate.
 *
 * Backend guard (controller-level):
 *   - POST /api/visit-plans without `zone_filter` → 400 when PLAN_ENFORCE_EF_SCOPE=true
 *   - admins (is_global) and demo users bypass the guard
 *
 * National estimate endpoint:
 *   - POST /api/visit-plans/preview/national-estimate
 *   - Returns { by_ef, totals, recommendation, no_google_calls: true }
 *   - Cache-first + Haversine fallback (NO Google Routes API calls)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'marzam-test';

test('Cambio 1 — controller exports nationalEstimate', () => {
  const controller = require('../../src/modules/visit-plans/visitPlans.controller');
  assert.equal(typeof controller.nationalEstimate, 'function');
  assert.equal(typeof controller.create, 'function');
});

test('Cambio 1 — service exports previewNationalEstimate', () => {
  const service = require('../../src/modules/visit-plans/visitPlans.service');
  assert.equal(typeof service.previewNationalEstimate, 'function');
});

test('Cambio 1 — routes has POST /preview/national-estimate', () => {
  // Routes are wired via Router instance; check by inspecting the layer stack.
  const router = require('../../src/modules/visit-plans/visitPlans.routes');
  const routes = router.stack
    .filter((l) => l.route && l.route.path)
    .map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
  const nationalRoute = routes.find((r) => r.path === '/preview/national-estimate');
  assert.ok(nationalRoute, `Expected /preview/national-estimate route`);
  assert.ok(nationalRoute.methods.includes('post'), `Expected POST on /preview/national-estimate`);
});

test('Cambio 1 — create endpoint blocks without zone_filter when guard ON', async () => {
  process.env.PLAN_ENFORCE_EF_SCOPE = 'true';
  // Clear require cache so the controller picks up the env var at runtime check.
  delete require.cache[require.resolve('../../src/modules/visit-plans/visitPlans.controller')];
  const controller = require('../../src/modules/visit-plans/visitPlans.controller');

  // Mock req/res for a non-admin, non-demo user.
  const req = {
    user: { id: 'u-1', role: 'gerente_ventas', data_scope: 'real', is_global: false },
    body: {
      scope_user_ids: ['u-2'],
      granularity: 'weekly',
      period_start: '2026-05-12',
      period_end: '2026-05-16',
      // NO zone_filter
    },
  };
  let statusCode = 0;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(p) { payload = p; return this; },
  };
  await new Promise((resolve, reject) => {
    controller.create(req, res, (err) => err ? reject(err) : resolve());
    // create is async; wait until res.json is called.
    setTimeout(resolve, 200);
  });
  assert.equal(statusCode, 400, `Expected 400 without zone_filter`);
  assert.equal(payload?.error, 'zone_filter_required');
  assert.ok(payload?._hint?.includes('Entidad Federativa'),
    `Hint should mention Entidad Federativa`);

  delete process.env.PLAN_ENFORCE_EF_SCOPE;
});

test('Cambio 1 — create endpoint allows admin (is_global) to bypass guard', async () => {
  process.env.PLAN_ENFORCE_EF_SCOPE = 'true';
  delete require.cache[require.resolve('../../src/modules/visit-plans/visitPlans.controller')];
  const controller = require('../../src/modules/visit-plans/visitPlans.controller');

  const req = {
    user: { id: 'admin-1', role: 'admin', is_global: true },
    body: {
      scope_user_ids: ['u-2'],
      granularity: 'weekly',
      period_start: '2026-05-12',
      period_end: '2026-05-16',
      // NO zone_filter — admin bypasses
    },
  };
  let statusCode = 0;
  const res = {
    status(code) { statusCode = code; return this; },
    json() { return this; },
  };
  // Admin path proceeds past the guard but will hit the service which fails
  // (no real DB). We only assert it DIDN'T return 400 from the guard.
  let nextError = null;
  await new Promise((resolve) => {
    controller.create(req, res, (err) => { nextError = err; resolve(); });
    setTimeout(resolve, 200);
  });
  assert.notEqual(statusCode, 400, `Admin should bypass EF guard, got status ${statusCode}`);
  delete process.env.PLAN_ENFORCE_EF_SCOPE;
});

test('Cambio 1 — create endpoint allows demo users to bypass guard', async () => {
  process.env.PLAN_ENFORCE_EF_SCOPE = 'true';
  delete require.cache[require.resolve('../../src/modules/visit-plans/visitPlans.controller')];
  const controller = require('../../src/modules/visit-plans/visitPlans.controller');

  const req = {
    user: { id: 'demo-1', role: 'representante', data_scope: 'demo', is_global: false },
    body: {
      scope_user_ids: ['u-2'],
      granularity: 'weekly',
      period_start: '2026-05-12',
      period_end: '2026-05-16',
      // NO zone_filter — demo bypasses
    },
  };
  let statusCode = 0;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(p) { payload = p; return this; },
  };
  await new Promise((resolve) => {
    controller.create(req, res, () => resolve());
    setTimeout(resolve, 200);
  });
  // Demo users bypass the EF guard but may hit other gates (quota, etc.).
  // Just verify it didn't return 'zone_filter_required'.
  assert.notEqual(payload?.error, 'zone_filter_required', `Demo should bypass EF guard`);
  delete process.env.PLAN_ENFORCE_EF_SCOPE;
});

test('Cambio 1 — create endpoint with zone_filter passes the guard', async () => {
  process.env.PLAN_ENFORCE_EF_SCOPE = 'true';
  delete require.cache[require.resolve('../../src/modules/visit-plans/visitPlans.controller')];
  const controller = require('../../src/modules/visit-plans/visitPlans.controller');

  const req = {
    user: { id: 'u-1', role: 'gerente_ventas', data_scope: 'real', is_global: false },
    body: {
      scope_user_ids: ['u-2'],
      granularity: 'weekly',
      period_start: '2026-05-12',
      period_end: '2026-05-16',
      zone_filter: 'Ecatepec de Morelos', // PRESENT
    },
  };
  let statusCode = 0;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(p) { payload = p; return this; },
  };
  await new Promise((resolve) => {
    controller.create(req, res, () => resolve());
    setTimeout(resolve, 200);
  });
  assert.notEqual(payload?.error, 'zone_filter_required', `With zone_filter, EF guard should not block`);
  delete process.env.PLAN_ENFORCE_EF_SCOPE;
});

test('Cambio 1 — flag OFF: create endpoint does NOT enforce EF', async () => {
  process.env.PLAN_ENFORCE_EF_SCOPE = 'false';
  delete require.cache[require.resolve('../../src/modules/visit-plans/visitPlans.controller')];
  const controller = require('../../src/modules/visit-plans/visitPlans.controller');

  const req = {
    user: { id: 'u-1', role: 'gerente_ventas', data_scope: 'real', is_global: false },
    body: {
      scope_user_ids: ['u-2'],
      granularity: 'weekly',
      period_start: '2026-05-12',
      period_end: '2026-05-16',
      // NO zone_filter — but flag OFF, so should NOT 400 from EF guard
    },
  };
  let payload = null;
  const res = {
    status() { return this; },
    json(p) { payload = p; return this; },
  };
  await new Promise((resolve) => {
    controller.create(req, res, () => resolve());
    setTimeout(resolve, 200);
  });
  assert.notEqual(payload?.error, 'zone_filter_required',
    `With flag OFF, EF guard must not fire`);
  delete process.env.PLAN_ENFORCE_EF_SCOPE;
});

test('Cambio 1 — empty zone_filter string also triggers guard (treat as missing)', async () => {
  process.env.PLAN_ENFORCE_EF_SCOPE = 'true';
  delete require.cache[require.resolve('../../src/modules/visit-plans/visitPlans.controller')];
  const controller = require('../../src/modules/visit-plans/visitPlans.controller');

  const req = {
    user: { id: 'u-1', role: 'gerente_ventas', data_scope: 'real', is_global: false },
    body: {
      scope_user_ids: ['u-2'],
      granularity: 'weekly',
      period_start: '2026-05-12',
      period_end: '2026-05-16',
      zone_filter: '   ', // whitespace only
    },
  };
  let payload = null;
  const res = {
    status() { return this; },
    json(p) { payload = p; return this; },
  };
  await new Promise((resolve) => {
    controller.create(req, res, () => resolve());
    setTimeout(resolve, 200);
  });
  assert.equal(payload?.error, 'zone_filter_required',
    `Whitespace-only zone_filter should be treated as missing`);
  delete process.env.PLAN_ENFORCE_EF_SCOPE;
});

test('Cambio 1 — __all__ sentinel triggers guard (treated as no zone)', async () => {
  process.env.PLAN_ENFORCE_EF_SCOPE = 'true';
  delete require.cache[require.resolve('../../src/modules/visit-plans/visitPlans.controller')];
  const controller = require('../../src/modules/visit-plans/visitPlans.controller');

  const req = {
    user: { id: 'u-1', role: 'gerente_ventas', data_scope: 'real', is_global: false },
    body: {
      scope_user_ids: ['u-2'],
      granularity: 'weekly',
      period_start: '2026-05-12',
      period_end: '2026-05-16',
      zone_filter: '__all__', // analytics sentinel
    },
  };
  let payload = null;
  const res = {
    status() { return this; },
    json(p) { payload = p; return this; },
  };
  await new Promise((resolve) => {
    controller.create(req, res, () => resolve());
    setTimeout(resolve, 200);
  });
  assert.equal(payload?.error, 'zone_filter_required',
    `__all__ sentinel should be treated as no zone`);
  delete process.env.PLAN_ENFORCE_EF_SCOPE;
});
