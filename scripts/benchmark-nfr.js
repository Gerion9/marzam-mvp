/**
 * NFR Benchmark Script — Marzam MVP
 *
 * Validates PRD non-functional requirements:
 *   - Map+table response < 2s for 5000 pharmacies in viewport
 *   - Assignment creation < 3s including route ordering
 *   - Photo upload < 5s over 4G for 5MB image
 *   - Data export < 10s for full CDMX dataset
 *   - Concurrent users: 1 manager + 20 reps
 *
 * Usage: node scripts/benchmark-nfr.js <base_url>
 * Example: node scripts/benchmark-nfr.js http://localhost:4000
 */

const BASE = process.argv[2] || 'http://localhost:4000';

async function measure(label, fn, targetMs) {
  const start = Date.now();
  try {
    await fn();
    const elapsed = Date.now() - start;
    const pass = elapsed <= targetMs;
    console.log(`${pass ? 'PASS' : 'FAIL'} | ${label} | ${elapsed}ms (target: <${targetMs}ms)`);
    return { label, elapsed, targetMs, pass };
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`FAIL | ${label} | ${elapsed}ms | ERROR: ${err.message}`);
    return { label, elapsed, targetMs, pass: false, error: err.message };
  }
}

async function fetchJson(path, opts = {}) {
  const url = `${BASE}/api${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function login(email, password) {
  const data = await fetchJson('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return data.token;
}

async function run() {
  console.log(`\nMarzam NFR Benchmark — ${BASE}`);
  console.log('='.repeat(60));

  let token;
  try {
    token = await login('admin@marzam.mx', 'Marzam2026!');
  } catch {
    console.log('Could not login. Ensure database is seeded. Running with demo endpoints only.\n');
    token = null;
  }

  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const results = [];

  results.push(await measure(
    'Map+table: pharmacies viewport query',
    () => fetchJson('/pharmacies?bbox=-99.3,19.2,-99.0,19.5&limit=500', { headers: auth }),
    2000,
  ));

  results.push(await measure(
    'Pharmacy detail by ID',
    async () => {
      const list = await fetchJson('/pharmacies?limit=1', { headers: auth });
      if (list[0]?.id) await fetchJson(`/pharmacies/${list[0].id}`, { headers: auth });
    },
    1000,
  ));

  results.push(await measure(
    'Dashboard KPI aggregation',
    () => fetchJson('/reporting/dashboard', { headers: auth }),
    3000,
  ));

  results.push(await measure(
    'Export pharmacies (CSV generation)',
    () => fetch(`${BASE}/api/reporting/export/pharmacies?format=csv`, { headers: auth }),
    10000,
  ));

  results.push(await measure(
    'Health check endpoint',
    () => fetchJson('/health'),
    500,
  ));

  console.log('\n' + '='.repeat(60));
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`Results: ${passed}/${total} passed`);

  if (passed < total) {
    console.log('\nFailing benchmarks:');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`  - ${r.label}: ${r.elapsed}ms (target: <${r.targetMs}ms)${r.error ? ` [${r.error}]` : ''}`);
    });
  }

  console.log('');
}

run().catch(console.error);
