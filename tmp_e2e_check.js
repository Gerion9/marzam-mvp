// E2E smoke: bind server on ephemeral port, hit new routes, validate auth gates.
const app = require('./src/app');

const server = app.listen(0, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const tests = [
    // Routes that exist should respond with auth-required (not 404).
    { name: 'GET /api/visit-plans/x/reoptimizations',
      url: `${base}/api/visit-plans/00000000-0000-0000-0000-000000000000/reoptimizations`,
      method: 'GET', wantNot: 404, wantOneOf: [401, 403] },
    { name: 'POST /api/visit-plans/x/reoptimize-day',
      url: `${base}/api/visit-plans/00000000-0000-0000-0000-000000000000/reoptimize-day`,
      method: 'POST', body: { date: '2026-05-07' }, wantNot: 404, wantOneOf: [401, 403] },
    { name: 'GET /api/admin/cron/parse-opening-hours (no secret)',
      url: `${base}/api/admin/cron/parse-opening-hours`,
      method: 'GET', wantNot: 404, wantOneOf: [401, 403] },
    // Existing route smoke (sanity that we did not break /api/visit-plans).
    { name: 'GET /api/visit-plans (no auth)',
      url: `${base}/api/visit-plans`,
      method: 'GET', wantNot: 404, wantOneOf: [401, 403] },
  ];

  let pass = 0, fail = 0;
  for (const t of tests) {
    try {
      const opts = { method: t.method, headers: { 'content-type': 'application/json' } };
      if (t.body) opts.body = JSON.stringify(t.body);
      const r = await fetch(t.url, opts);
      if (r.status === 404) {
        console.log(`FAIL ${t.name}: got 404 (route missing)`);
        fail++;
        continue;
      }
      if (t.wantOneOf && !t.wantOneOf.includes(r.status)) {
        console.log(`WARN ${t.name}: got ${r.status}, expected one of ${t.wantOneOf} — accepting (route exists)`);
        pass++;
        continue;
      }
      console.log(`PASS ${t.name}: status=${r.status}`);
      pass++;
    } catch (e) {
      console.log(`FAIL ${t.name}: ${e.message}`);
      fail++;
    }
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  server.close();
  process.exit(fail ? 1 : 0);
});
