const test = require('node:test');
const assert = require('node:assert/strict');

// Set the minimum env vars so requiring planGenerator (which transitively
// requires routeOptimization) doesn't fail at module load time. The actual
// API key check happens inside getAuthHeaders() at call time, and our tests
// always inject a stub _optimizer so that path is never reached.
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'marzam-test';

const pg = require('../../src/modules/visit-plans/planGenerator');
const routesMatrix = require('../../src/services/routesMatrix');

const STOPS = [
  { id: 'A', lat: 19.43, lng: -99.13, pareto: 'A' },
  { id: 'B', lat: 19.44, lng: -99.14, pareto: 'B' },
  { id: 'C', lat: 19.45, lng: -99.15, pareto: 'C' },
];
const HOME = { lat: 19.42, lng: -99.12 };
const DURATIONS = [
  [0, 600, 720, 840],
  [600, 0, 480, 720],
  [720, 480, 0, 600],
  [840, 720, 600, 0],
];

function fakeUser(extra = {}) {
  return {
    id: 'rep-1',
    home_lat: HOME.lat,
    home_lng: HOME.lng,
    service_minutes_per_stop: 30,
    daily_minutes_cap: 480,
    daily_km_cap: 200,
    ...extra,
  };
}

test('tryOptimizationApi: < 2 stops returns null without calling optimizer', async () => {
  const calls = [];
  const stub = { optimizeTours: async (...a) => { calls.push(a); return {}; } };
  const r = await pg.tryOptimizationApi({
    user: fakeUser(), stops: [STOPS[0]], home: HOME,
    durationsMatrix: [[0, 600], [600, 0]], _optimizer: stub,
  });
  assert.equal(r, null);
  assert.equal(calls.length, 0);
});

test('tryOptimizationApi: missing home returns null', async () => {
  const calls = [];
  const stub = { optimizeTours: async (...a) => { calls.push(a); return {}; } };
  const r = await pg.tryOptimizationApi({
    user: fakeUser(), stops: STOPS, home: null,
    durationsMatrix: DURATIONS, _optimizer: stub,
  });
  assert.equal(r, null);
  assert.equal(calls.length, 0);
});

test('tryOptimizationApi: missing duration matrix returns null', async () => {
  const r = await pg.tryOptimizationApi({
    user: fakeUser(), stops: STOPS, home: HOME,
    durationsMatrix: null, _optimizer: { optimizeTours: async () => ({}) },
  });
  assert.equal(r, null);
});

test('tryOptimizationApi: success path returns ordered stops preserving identity', async () => {
  let received = null;
  const stub = {
    optimizeTours: async (args) => {
      received = args;
      return {
        routes: [{
          vehicleIndex: 0,
          visits: [
            { shipmentIndex: 2 }, // C
            { shipmentIndex: 0 }, // A
            { shipmentIndex: 1 }, // B
          ],
        }],
      };
    },
  };
  const r = await pg.tryOptimizationApi({
    user: fakeUser(), stops: STOPS, home: HOME,
    durationsMatrix: DURATIONS, _optimizer: stub,
  });
  assert.ok(Array.isArray(r));
  assert.deepEqual(r.map((s) => s.id), ['C', 'A', 'B']);
  // The vehicles array carries the user's caps so the solver can respect them.
  assert.equal(received.vehicles[0].routeDurationLimitMin, 480);
  assert.equal(received.vehicles[0].routeDistanceLimitKm, 200);
  // Shipments carry Pareto penalty (A=1000, B=500, C=200).
  const penalties = received.shipments.map((s) => s.penaltyCost);
  assert.deepEqual(penalties, [1000, 500, 200]);
  // The duration matrix is forwarded as-is; distance matrix is computed via
  // Haversine (positive, monotone with the layout).
  assert.deepEqual(received.durationMatrix, DURATIONS);
  assert.equal(received.distanceMatrix.length, 4);
  assert.equal(received.distanceMatrix[0][0], 0);
  assert.ok(received.distanceMatrix[0][1] > 0);
});

test('tryOptimizationApi: optimizer throw propagates (caller catches)', async () => {
  const stub = { optimizeTours: async () => { throw new Error('http_503'); } };
  await assert.rejects(
    () => pg.tryOptimizationApi({
      user: fakeUser(), stops: STOPS, home: HOME,
      durationsMatrix: DURATIONS, _optimizer: stub,
    }),
    /http_503/,
  );
});

test('tryOptimizationApi: empty visits array returns null', async () => {
  const stub = {
    optimizeTours: async () => ({ routes: [{ vehicleIndex: 0, visits: [] }] }),
  };
  const r = await pg.tryOptimizationApi({
    user: fakeUser(), stops: STOPS, home: HOME,
    durationsMatrix: DURATIONS, _optimizer: stub,
  });
  assert.equal(r, null);
});

test('tryOptimizationApi: shipment skill list forwarded as requiredCapabilities', async () => {
  const stopsWithSkills = [
    { ...STOPS[0], required_skills: ['marzam_maintenance'] },
    { ...STOPS[1], required_skills: null },
    { ...STOPS[2] },
  ];
  let received = null;
  const stub = {
    optimizeTours: async (args) => {
      received = args;
      return { routes: [{ visits: [{ shipmentIndex: 0 }] }] };
    },
  };
  await pg.tryOptimizationApi({
    user: fakeUser(), stops: stopsWithSkills, home: HOME,
    durationsMatrix: DURATIONS, _optimizer: stub,
  });
  assert.deepEqual(received.shipments[0].requiredCapabilities, ['marzam_maintenance']);
  assert.equal(received.shipments[1].requiredCapabilities, undefined);
  assert.equal(received.shipments[2].requiredCapabilities, undefined);
});

test('paretoPenalty: A>B>C>D, unknown defaults to 100', () => {
  assert.equal(pg.paretoPenalty('A'), 1000);
  assert.equal(pg.paretoPenalty('B'), 500);
  assert.equal(pg.paretoPenalty('C'), 200);
  assert.equal(pg.paretoPenalty('D'), 50);
  assert.equal(pg.paretoPenalty('Z'), 100);
  assert.equal(pg.paretoPenalty(null), 100);
});

// ── routesMatrix.extractMatrixForOptimization ────────────────────────────

test('extractMatrixForOptimization: throws on < 2 points', async () => {
  await assert.rejects(
    () => routesMatrix.extractMatrixForOptimization([{ lat: 1, lng: 2 }]),
    /at least 2 points/,
  );
});

test('extractMatrixForOptimization: builds 2D matrices from rawMatrix and backfills missing cells via Haversine', async () => {
  const points = [
    { lat: 19.43, lng: -99.13 },
    { lat: 19.44, lng: -99.14 },
    { lat: 19.45, lng: -99.15 },
  ];
  const rawMatrix = [
    // Only 4 of 9 cells supplied — the rest get Haversine-fallback.
    { originIndex: 0, destinationIndex: 1, durationSeconds: 600, distanceMeters: 4500 },
    { originIndex: 1, destinationIndex: 0, durationSeconds: 600, distanceMeters: 4500 },
    { originIndex: 1, destinationIndex: 2, durationSeconds: 480, distanceMeters: 3800 },
    { originIndex: 2, destinationIndex: 1, durationSeconds: 480, distanceMeters: 3800 },
  ];
  const { durationMatrix, distanceMatrix } = await routesMatrix.extractMatrixForOptimization(points, { rawMatrix });
  assert.equal(durationMatrix.length, 3);
  assert.equal(durationMatrix[0][0], 0);
  assert.equal(durationMatrix[0][1], 600);
  assert.equal(durationMatrix[1][2], 480);
  // 0→2 and 2→0 fall back to Haversine.
  assert.ok(durationMatrix[0][2] > 0);
  assert.ok(durationMatrix[2][0] > 0);
  // Distance matrix mirrors structure.
  assert.equal(distanceMatrix[0][0], 0);
  assert.equal(distanceMatrix[0][1], 4500);
  assert.ok(distanceMatrix[0][2] > 0);
});
