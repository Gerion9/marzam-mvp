const test = require('node:test');
const assert = require('node:assert/strict');

// Boot-time env requirement — set before requiring the module.
process.env.GOOGLE_CLOUD_PROJECT = 'marzam-test';
process.env.GOOGLE_MAPS_OPTIMIZATION_API_KEY = 'test-key';

const {
  buildPayload,
  callOptimizeTours,
  DEFAULT_TIMEOUT_SECONDS,
  ENDPOINT_BASE,
} = require('../../src/services/routeOptimization');

// ── buildPayload shape ──────────────────────────────────────────────────

const fixture = () => ({
  vehicles: [{
    id: 'rep-1',
    startLocation: { lat: 19.4326, lng: -99.1332 },
    routeDurationLimitMin: 480,
    routeDistanceLimitKm: 200,
  }],
  shipments: [
    {
      id: 'pharmacy-A',
      deliveryLocation: { lat: 19.4361, lng: -99.1411 },
      durationMinutes: 30,
      penaltyCost: 1000,
    },
    {
      id: 'pharmacy-B',
      deliveryLocation: { lat: 19.4290, lng: -99.1280 },
      durationMinutes: 20,
      penaltyCost: 500,
    },
  ],
  durationMatrix: [
    [0, 600, 720],
    [600, 0, 480],
    [720, 480, 0],
  ],
  distanceMatrix: [
    [0, 4500, 5300],
    [4500, 0, 3800],
    [5300, 3800, 0],
  ],
});

test('buildPayload: parent uses GOOGLE_CLOUD_PROJECT', () => {
  const p = buildPayload(fixture());
  assert.equal(p.parent, 'projects/marzam-test');
});

test('buildPayload: searchMode default is CONSUME_ALL_AVAILABLE_TIME', () => {
  const p = buildPayload(fixture());
  assert.equal(p.searchMode, 'CONSUME_ALL_AVAILABLE_TIME');
  assert.equal(p.timeout, `${DEFAULT_TIMEOUT_SECONDS}s`);
});

test('buildPayload: vehicles emit startLocation, fallback endLocation, route limits', () => {
  const p = buildPayload(fixture());
  const v = p.model.vehicles[0];
  assert.deepEqual(v.startLocation, { latitude: 19.4326, longitude: -99.1332 });
  // No endLocation supplied → defaults to startLocation (round trip).
  assert.deepEqual(v.endLocation, { latitude: 19.4326, longitude: -99.1332 });
  assert.equal(v.travelMode, 'DRIVING');
  assert.equal(v.routeDurationLimit.maxDuration, '28800s'); // 480min × 60
  assert.equal(v.routeDistanceLimit.maxMeters, 200000);     // 200km × 1000
});

test('buildPayload: shipments emit pickups with duration + penaltyCost', () => {
  const p = buildPayload(fixture());
  const [s1, s2] = p.model.shipments;
  assert.equal(s1.label, 'stop:pharmacy-A');
  assert.deepEqual(s1.pickups[0].arrivalLocation, { latitude: 19.4361, longitude: -99.1411 });
  assert.equal(s1.pickups[0].duration, '1800s'); // 30min × 60
  assert.equal(s1.penaltyCost, 1000);
  assert.equal(s2.penaltyCost, 500);
});

test('buildPayload: time windows surface when both hard_window_* set', () => {
  const f = fixture();
  f.shipments[0].hardWindowStart = '2026-05-10T15:00:00Z';
  f.shipments[0].hardWindowEnd = '2026-05-10T17:00:00Z';
  const p = buildPayload(f);
  const tw = p.model.shipments[0].pickups[0].timeWindows;
  assert.ok(Array.isArray(tw) && tw.length === 1);
  assert.equal(tw[0].startTime, '2026-05-10T15:00:00Z');
  assert.equal(tw[0].endTime, '2026-05-10T17:00:00Z');
});

test('buildPayload: skills get appended to shipment label (soft hint)', () => {
  const f = fixture();
  f.shipments[0].requiredCapabilities = ['new_pharmacy_capture'];
  const p = buildPayload(f);
  assert.match(p.model.shipments[0].label, /skills:new_pharmacy_capture/);
});

test('buildPayload: durationDistanceMatrices use proto-duration strings', () => {
  const p = buildPayload(fixture());
  const m = p.model.durationDistanceMatrices[0];
  assert.equal(m.rows.length, 3);
  assert.deepEqual(m.rows[0].durations, ['0s', '600s', '720s']);
  assert.deepEqual(m.rows[0].meters, [0, 4500, 5300]);
});

test('buildPayload: empty vehicles or shipments → throws', () => {
  assert.throws(() => buildPayload({ ...fixture(), vehicles: [] }), /vehicles/);
  assert.throws(() => buildPayload({ ...fixture(), shipments: [] }), /shipments/);
});

test('buildPayload: missing matrices → throws', () => {
  assert.throws(() => buildPayload({ ...fixture(), durationMatrix: null }), /Matrix|matrix/);
});

// ── callOptimizeTours retry/timeout/success ──────────────────────────────

function makeFetchStub(responses) {
  let i = 0;
  const calls = [];
  return {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses[i] || responses[responses.length - 1];
      i += 1;
      if (r.throw) throw r.throw;
      return {
        ok: r.ok,
        status: r.status,
        json: async () => r.json ?? {},
        text: async () => r.text ?? '',
      };
    },
    calls: () => calls,
    count: () => i,
  };
}

test('callOptimizeTours: 200 OK on first try, no retry', async () => {
  const stub = makeFetchStub([{ ok: true, status: 200, json: { routes: [] } }]);
  const payload = buildPayload(fixture());
  const { parsed } = await callOptimizeTours(payload, {
    fetchImpl: stub.fetch, maxRetries: 2, timeoutSeconds: 5,
  });
  assert.deepEqual(parsed, { routes: [] });
  assert.equal(stub.count(), 1);
  // URL hits the v1 optimizeTours endpoint with the parent embedded.
  assert.equal(stub.calls()[0].url, `${ENDPOINT_BASE}/projects/marzam-test:optimizeTours`);
  // Auth header lands.
  assert.ok(stub.calls()[0].init.headers['X-Goog-Api-Key']);
});

test('callOptimizeTours: 503 retried, eventual 200', async () => {
  const stub = makeFetchStub([
    { ok: false, status: 503, text: 'overloaded' },
    { ok: true, status: 200, json: { routes: ['ok'] } },
  ]);
  const payload = buildPayload(fixture());
  const { parsed } = await callOptimizeTours(payload, {
    fetchImpl: stub.fetch, maxRetries: 2, timeoutSeconds: 5,
  });
  assert.deepEqual(parsed, { routes: ['ok'] });
  assert.equal(stub.count(), 2);
});

test('callOptimizeTours: 400 non-retryable → throws immediately', async () => {
  const stub = makeFetchStub([{ ok: false, status: 400, text: 'bad request' }]);
  const payload = buildPayload(fixture());
  await assert.rejects(
    () => callOptimizeTours(payload, {
      fetchImpl: stub.fetch, maxRetries: 2, timeoutSeconds: 5,
    }),
    /route_optimization_http_400/,
  );
  assert.equal(stub.count(), 1);
});

test('callOptimizeTours: retries exhausted on 429 → throws last error', async () => {
  const stub = makeFetchStub([
    { ok: false, status: 429, text: 'rate limit' },
    { ok: false, status: 429, text: 'rate limit' },
    { ok: false, status: 429, text: 'rate limit' },
  ]);
  const payload = buildPayload(fixture());
  await assert.rejects(
    () => callOptimizeTours(payload, {
      fetchImpl: stub.fetch, maxRetries: 2, timeoutSeconds: 5,
    }),
    /route_optimization_http_429/,
  );
  // maxRetries=2 → up to 3 attempts.
  assert.equal(stub.count(), 3);
});

test('callOptimizeTours: AbortError surfaces as a timeout', async () => {
  const stub = makeFetchStub([{ throw: Object.assign(new Error('aborted'), { name: 'AbortError' }) }]);
  const payload = buildPayload(fixture());
  await assert.rejects(
    () => callOptimizeTours(payload, {
      fetchImpl: stub.fetch, maxRetries: 0, timeoutSeconds: 1,
    }),
    /route_optimization_timeout_/,
  );
});

test('callOptimizeTours: missing API key → throws auth error', async () => {
  const original = process.env.GOOGLE_MAPS_OPTIMIZATION_API_KEY;
  delete process.env.GOOGLE_MAPS_OPTIMIZATION_API_KEY;
  delete process.env.GOOGLE_OPT_ACCESS_TOKEN;
  const stub = makeFetchStub([{ ok: true, status: 200, json: {} }]);
  const payload = buildPayload(fixture());
  await assert.rejects(
    () => callOptimizeTours(payload, { fetchImpl: stub.fetch, maxRetries: 0 }),
    /No auth/,
  );
  process.env.GOOGLE_MAPS_OPTIMIZATION_API_KEY = original;
});

test('module surface: exports the documented API', () => {
  const m = require('../../src/services/routeOptimization');
  assert.equal(typeof m.optimizeTours, 'function');
  assert.equal(typeof m.recordOptimizationSpend, 'function');
  assert.equal(typeof m.buildPayload, 'function');
  assert.equal(typeof m.callOptimizeTours, 'function');
});

test('buildPayload: solvingMode=VALIDATE_ONLY is forwarded when options.validateOnly true', () => {
  const f = fixture();
  const p = buildPayload({ ...f, options: { validateOnly: true } });
  assert.equal(p.solvingMode, 'VALIDATE_ONLY');
});

test('buildPayload: solvingMode is omitted by default (DEFAULT_SOLVE implicit)', () => {
  const p = buildPayload(fixture());
  assert.equal(p.solvingMode, undefined);
});

test('buildPayload: solvingMode can be passed verbatim via options.solvingMode', () => {
  const p = buildPayload({ ...fixture(), options: { solvingMode: 'VALIDATE_ONLY' } });
  assert.equal(p.solvingMode, 'VALIDATE_ONLY');
});

test('callOptimizeTours: VALIDATE_ONLY surfaces solvingMode in body', async () => {
  const stub = makeFetchStub([{ ok: true, status: 200, json: { routes: [] } }]);
  const payload = buildPayload({ ...fixture(), options: { validateOnly: true } });
  await callOptimizeTours(payload, {
    fetchImpl: stub.fetch, maxRetries: 0, timeoutSeconds: 5,
  });
  const sentBody = JSON.parse(stub.calls()[0].init.body);
  assert.equal(sentBody.solvingMode, 'VALIDATE_ONLY');
});

test('callOptimizeTours: omits solvingMode in body when not set (no DEFAULT_SOLVE echoed)', async () => {
  const stub = makeFetchStub([{ ok: true, status: 200, json: { routes: [] } }]);
  const payload = buildPayload(fixture());
  await callOptimizeTours(payload, {
    fetchImpl: stub.fetch, maxRetries: 0, timeoutSeconds: 5,
  });
  const sentBody = JSON.parse(stub.calls()[0].init.body);
  assert.equal(sentBody.solvingMode, undefined);
});
