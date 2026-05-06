// End-to-end: visitPlans.service.routePreview with synthetic stops.
// Mocks fetch to return canned matrix + route; confirms full pipeline runs
// without errors and returns a valid plan shape.

(async () => {
  let pass = 0, fail = 0;
  const check = (cond, desc) => { if (cond) { pass++; console.log('PASS ' + desc); } else { fail++; console.log('FAIL ' + desc); } };

  let fetchCount = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    fetchCount++;
    if (url.includes('computeRouteMatrix')) {
      const body = JSON.parse(opts.body);
      const O = body.origins.length;
      const D = body.destinations.length;
      const out = [];
      for (let i = 0; i < O; i++) for (let j = 0; j < D; j++) {
        out.push({
          originIndex: i, destinationIndex: j,
          duration: ((Math.abs(i-j)+1)*120) + 's',
          distanceMeters: Math.abs(i-j) * 1500 + 500,
        });
      }
      return { ok: true, status: 200, async json() { return out; } };
    }
    if (url.includes('directions/v2:computeRoutes')) {
      return { ok: true, status: 200, async json() {
        return { routes: [{ duration: '180s', distanceMeters: 1500, polyline: { encodedPolyline: 'fake' } }] };
      }};
    }
    return { ok: false, status: 404, async json() { return {}; }, async text() { return 'not found'; } };
  };

  const service = require('./src/modules/visit-plans/visitPlans.service');

  const N = 12;
  const users = [{ id: 'u1', home_lat: 19.40, home_lng: -99.20 }];
  const stops = Array.from({length: N}, (_, i) => ({
    id: 's' + i,
    user_id: 'u1',
    lat: 19.40 + (Math.random() - 0.5) * 0.1,
    lng: -99.20 + (Math.random() - 0.5) * 0.1,
    name: 'Farmacia ' + i,
    pareto: 'A',
  }));

  let result;
  try {
    result = await service.routePreview({
      users, stops, date: '2026-05-07',
      service_minutes_per_stop: 45,
    });
  } catch (e) {
    fail++;
    console.log('FAIL routePreview threw: ' + e.message);
    global.fetch = realFetch;
    process.exit(1);
  }

  check(result && Array.isArray(result.routes), 'routePreview returns routes[]');
  check(result.routes.length === 1, '1 route returned');
  check(result.routes[0].stops.length === N, `${N} stops sequenced`);
  check(result.routes[0].total_drive_minutes > 0, 'total_drive_minutes > 0');
  check(typeof result.cost_estimate === 'object', 'cost_estimate present');
  check(result.cost_estimate.matrix_elements_total > 0, 'matrix_elements_total > 0');
  check(result.cost_estimate.matrix_fresh + result.cost_estimate.matrix_cached + result.cost_estimate.matrix_estimated_fallback > 0,
    'matrix breakdown coherent');
  check(typeof result.cost_estimate.estimated_usd === 'number', 'estimated_usd numeric');
  // Stops should have monotonically increasing route_order.
  let orderOk = true;
  for (let i = 1; i < result.routes[0].stops.length; i++) {
    if (result.routes[0].stops[i].route_order !== i + 1) { orderOk = false; break; }
  }
  check(orderOk, 'route_order is sequential 1..N');

  console.log(`\n${pass} pass, ${fail} fail (Google fetch calls intercepted: ${fetchCount})`);
  global.fetch = realFetch;
  process.exit(fail ? 1 : 0);
})();
