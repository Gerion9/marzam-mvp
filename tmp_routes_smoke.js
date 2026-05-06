// Smoke test for routesMatrix invariants without hitting Google.
// Patches global.fetch to intercept the API call and inspect the request shape.

(async () => {
  let pass = 0, fail = 0;
  const check = (cond, desc) => { if (cond) { pass++; console.log('PASS ' + desc); } else { fail++; console.log('FAIL ' + desc); } };

  // ── Test 1: TRAFFIC_AWARE without departureTime throws ──
  const rm = require('./src/services/routesMatrix');
  try {
    await rm.computeMatrix(
      [{ lat: 19.4, lng: -99.2 }],
      [{ lat: 19.5, lng: -99.1 }],
      { preference: 'TRAFFIC_AWARE' /* no departureTime */ },
    );
    fail++;
    console.log('FAIL TRAFFIC_AWARE without departureTime should throw — but did not');
  } catch (e) {
    check(/TRAFFIC_AWARE matrix call requires opts.departureTime/.test(e.message),
      'TRAFFIC_AWARE without departureTime throws (msg: ' + e.message.slice(0, 80) + ')');
  }

  // ── Test 2: computeMatrixWithPolyline forwards fieldMask='with_polyline' ──
  let captured = null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    captured = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    // Return a fake successful matrix response.
    return {
      ok: true,
      status: 200,
      async json() {
        return [
          { originIndex: 0, destinationIndex: 0,
            duration: '120s', distanceMeters: 1000,
            polyline: { encodedPolyline: 'fake_poly_abc' } },
        ];
      },
    };
  };

  try {
    // Use unique geohash to ensure cache miss.
    const o = [{ lat: 19.999991, lng: -99.999992 }];
    const d = [{ lat: 20.000001, lng: -99.000003 }];
    const result = await rm.computeMatrixWithPolyline(o, d, { preference: 'TRAFFIC_UNAWARE' });
    check(captured?.headers?.['X-Goog-FieldMask']?.includes('polyline.encodedPolyline'),
      `field mask includes polyline (got: ${captured?.headers?.['X-Goog-FieldMask']})`);
    check(result.length === 1, 'returned 1 element');
    check(result[0].polyline === 'fake_poly_abc', 'polyline propagated to result');
    check(result[0].flag === 'fresh', 'flag = fresh on first fetch');
  } finally {
    global.fetch = realFetch;
  }

  // ── Test 3: getMatrixBreakdown sums sink correctly ──
  const sink = { fresh: 5, cached: 10, estimated: 2 };
  const bd = rm.getMatrixBreakdown(sink);
  check(bd.total === 17, `breakdown.total = ${bd.total} (want 17)`);
  check(bd.cached === 10, 'breakdown.cached preserved');

  // ── Test 4: metricsSink populated by computeMatrixCached ──
  // Use cache hit by querying a cell we just wrote (fake_poly_abc was persisted).
  const sink2 = { fresh: 0, cached: 0, estimated: 0 };
  global.fetch = async () => { throw new Error('should hit cache'); };
  try {
    const o2 = [{ lat: 19.999991, lng: -99.999992 }];
    const d2 = [{ lat: 20.000001, lng: -99.000003 }];
    const r = await rm.computeMatrixCached(o2, d2, { preference: 'TRAFFIC_UNAWARE', metricsSink: sink2 });
    check(sink2.cached >= 1, `cache hit recorded in sink — cached=${sink2.cached}`);
  } finally {
    global.fetch = realFetch;
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
