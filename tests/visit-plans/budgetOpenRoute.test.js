/**
 * Cambio 4 — Reloj corre desde primera farmacia.
 *
 * When PLAN_OPEN_ROUTE_BUDGET=true:
 *   - The home→firstStop travel time is NOT counted in:
 *       jornada cap (daily_minutes_cap)
 *       manejo cap (travel_minutes_cap)
 *       km cap   (daily_km_cap)
 *   - The lastStop→home return leg is NOT counted in those caps either.
 *   - The first farmacia ETA = routeStartHHMM exactly (default 08:00).
 *
 * When the flag is OFF (legacy):
 *   - Border legs ARE included in caps (existing behavior).
 *   - First farmacia ETA = routeStartHHMM + home→f1 travel time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'marzam-test';

// Helper to load a fresh planGenerator with a specific env var value.
function loadPgWithEnv(envOverrides = {}) {
  const saved = {};
  for (const k of Object.keys(envOverrides)) {
    saved[k] = process.env[k];
    process.env[k] = envOverrides[k];
  }
  delete require.cache[require.resolve('../../src/modules/visit-plans/planGenerator')];
  const pg = require('../../src/modules/visit-plans/planGenerator');
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return pg;
}

// Fixture: rep home 5km south of first stop. Three stops in a line going north.
// Haversine approx between (19.40,-99.10) and (19.45,-99.10) ≈ 5.55 km
// ×1.4 / 22 km/h × 60 ≈ 21 min per inter-stop leg
const REP = { id: 'r1', home_lat: 19.40, home_lng: -99.10, service_minutes_per_stop: 30 };
const STOPS = [
  { lat: 19.45, lng: -99.10 }, // 5.5 km north of home
  { lat: 19.50, lng: -99.10 },
  { lat: 19.55, lng: -99.10 },
];

test('Cambio 4 — flag OFF: estimateDayMinutes includes border legs (legacy behavior)', () => {
  const pg = loadPgWithEnv({ PLAN_OPEN_ROUTE_BUDGET: 'false', PLAN_HOMELESS_OPEN_ROUTE: 'false' });
  const minutes = pg.estimateDayMinutes(REP, STOPS, null);
  // legacy = home→f1 (~21min) + f1→f2 (~21min) + f2→f3 (~21min) + f3→home (~63min)
  //        + 3×30min service = ~216min total
  // The exact number depends on Haversine math; assert a wide window.
  assert.ok(minutes > 180 && minutes < 250,
    `Legacy total should be ~210-220 min including border legs, got ${minutes}`);
});

test('Cambio 4 — flag ON: estimateDayMinutes excludes border legs', () => {
  const pg = loadPgWithEnv({ PLAN_OPEN_ROUTE_BUDGET: 'true' });
  const minutes = pg.estimateDayMinutes(REP, STOPS, null);
  // open-route = f1→f2 (~21min) + f2→f3 (~21min) + 3×30 service = ~132min
  // (no home→f1, no f3→home)
  assert.ok(minutes > 100 && minutes < 170,
    `Open-route total should be ~130 min excluding border legs, got ${minutes}`);
});

test('Cambio 4 — flag ON: shorter day than legacy (border legs excluded saves >50min)', () => {
  const pgOff = loadPgWithEnv({ PLAN_OPEN_ROUTE_BUDGET: 'false' });
  const pgOn = loadPgWithEnv({ PLAN_OPEN_ROUTE_BUDGET: 'true' });
  const legacy = pgOff.estimateDayMinutes(REP, STOPS, null);
  const openR = pgOn.estimateDayMinutes(REP, STOPS, null);
  assert.ok(legacy - openR > 50,
    `Open-route should save >50min vs legacy (border legs); diff was ${legacy - openR}`);
});

test('Cambio 4 — flag ON: single-stop day = service only (no travel anywhere)', () => {
  const pg = loadPgWithEnv({ PLAN_OPEN_ROUTE_BUDGET: 'true' });
  const minutes = pg.estimateDayMinutes(REP, [STOPS[0]], null);
  // 1 stop, no inter-stop travel, no border legs → only service (30 min)
  assert.equal(minutes, 30, `Single stop with open-route should be service only`);
});

test('Cambio 4 — flag OFF: single-stop day still includes home↔stop round trip (legacy)', () => {
  const pg = loadPgWithEnv({ PLAN_OPEN_ROUTE_BUDGET: 'false' });
  const minutes = pg.estimateDayMinutes(REP, [STOPS[0]], null);
  // 1 stop, home→stop + stop→home + service
  // ~21 + 21 + 30 = ~72 min
  assert.ok(minutes > 60 && minutes < 90, `Legacy single stop should be ~70min, got ${minutes}`);
});

test('Cambio 4 — flag ON: rep without home gets open-route via PLAN_HOMELESS_OPEN_ROUTE', () => {
  const pg = loadPgWithEnv({
    PLAN_OPEN_ROUTE_BUDGET: 'false',
    PLAN_HOMELESS_OPEN_ROUTE: 'true',
  });
  const homelessRep = { ...REP, home_lat: null, home_lng: null };
  const minutes = pg.estimateDayMinutes(homelessRep, STOPS, null);
  // Without home, open-route applies regardless: same as Cambio 4 ON
  assert.ok(minutes > 100 && minutes < 170,
    `Homeless rep with PLAN_HOMELESS_OPEN_ROUTE ON should get open-route total ~130min, got ${minutes}`);
});

test('Cambio 4 — flag OFF, no home: legacy code returns 0 (rep excluded)', () => {
  const pg = loadPgWithEnv({
    PLAN_OPEN_ROUTE_BUDGET: 'false',
    PLAN_HOMELESS_OPEN_ROUTE: 'false',
  });
  const homelessRep = { ...REP, home_lat: null, home_lng: null };
  const minutes = pg.estimateDayMinutes(homelessRep, STOPS, null);
  // Legacy: no home → returns 0 (rep gets no balance contribution)
  assert.equal(minutes, 0, `Legacy homeless rep should return 0`);
});

test('Cambio 4 — flags exposed for runtime introspection', () => {
  const pg = loadPgWithEnv({ PLAN_OPEN_ROUTE_BUDGET: 'true' });
  assert.equal(pg._flags.ENABLE_OPEN_ROUTE_BUDGET, true);
  assert.equal(pg._flags.ENABLE_HOMELESS_OPEN_ROUTE, false);
});

test('Cambio 4 — math sanity: Haversine distance home→f1 ≈ 5.5km, ~21min', () => {
  const pg = loadPgWithEnv({});
  const km = pg.haversineKm({ lat: 19.40, lng: -99.10 }, { lat: 19.45, lng: -99.10 });
  assert.ok(km > 5.4 && km < 5.7, `Expected ~5.5km, got ${km}`);
  const minutes = pg.estimateMinutes({ lat: 19.40, lng: -99.10 }, { lat: 19.45, lng: -99.10 });
  assert.ok(minutes >= 18 && minutes <= 24, `Expected ~21min, got ${minutes}`);
});

test('Cambio 4 — public API surface preserved across flag toggle', () => {
  const pgOff = loadPgWithEnv({ PLAN_OPEN_ROUTE_BUDGET: 'false' });
  const pgOn = loadPgWithEnv({ PLAN_OPEN_ROUTE_BUDGET: 'true' });
  for (const fn of ['generate', 'previewGenerate', 'estimateCost', 'buildPlan']) {
    assert.equal(typeof pgOff[fn], 'function', `pgOff.${fn}`);
    assert.equal(typeof pgOn[fn], 'function', `pgOn.${fn}`);
  }
});
