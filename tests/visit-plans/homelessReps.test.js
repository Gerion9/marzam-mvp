/**
 * Cambio 2 — Reps sin domicilio reciben ruta optimizada (Opción B).
 *
 * When PLAN_HOMELESS_OPEN_ROUTE=true:
 *   - Reps without home_lat/lng are INCLUDED in clustering via k-means++ seeding.
 *   - Their virtual depot is the auto-referential centroid (mean of assigned stops).
 *   - Cap accounting + sequencing treat them as "open route" (no border legs counted).
 *
 * When the flag is OFF (legacy):
 *   - Reps without home get an EMPTY cluster.
 *   - No stops assigned to them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { clusterByHome, haversineKm } = require('../../src/utils/kmeans');

const REPS_2 = [
  { id: 'r1', home_lat: 19.40, home_lng: -99.10, employee_code: 'A001' },
  { id: 'r2', home_lat: null, home_lng: null, employee_code: 'A002' },
];

// 6 candidates in two clusters: 3 near r1's home, 3 far north (would form own cluster).
const CANDIDATES_6 = [
  { id: 'c1', lat: 19.405, lng: -99.10 },
  { id: 'c2', lat: 19.41, lng: -99.10 },
  { id: 'c3', lat: 19.415, lng: -99.105 },
  { id: 'c4', lat: 19.60, lng: -99.10 }, // ~22 km north
  { id: 'c5', lat: 19.62, lng: -99.10 },
  { id: 'c6', lat: 19.61, lng: -99.11 },
];

test('Cambio 2 — flag OFF: rep without home gets empty cluster (legacy)', () => {
  const { byRep } = clusterByHome(REPS_2, CANDIDATES_6, { enableHomeless: false });
  // r1 has home, gets all candidates (legacy: only one rep with home, so all go to it).
  // r2 has no home, gets nothing.
  assert.equal(byRep.get('r1').length, 6, `Legacy: r1 with home gets all 6 candidates`);
  assert.equal(byRep.get('r2').length, 0, `Legacy: r2 without home gets 0 candidates`);
});

test('Cambio 2 — flag ON: rep without home gets cluster via k-means++', () => {
  const { byRep, centroidByRepId } = clusterByHome(REPS_2, CANDIDATES_6, { enableHomeless: true });
  // r2 should now have a cluster (probably the far-north 3 since k-means++ seeded
  // it with the farthest candidate from r1's home).
  assert.ok(byRep.get('r2').length > 0, `r2 should have non-empty cluster with homeless ON`);
  // Both reps should split the 6 candidates without losing any.
  assert.equal(byRep.get('r1').length + byRep.get('r2').length, 6);
  // r2's centroid should be auto-referential (mean of its assigned stops).
  const c2 = centroidByRepId.get('r2');
  assert.ok(c2, `centroidByRepId should expose r2's virtual depot`);
  assert.equal(c2.hasHome, false, `r2's centroid is auto-referential, not home`);
});

test('Cambio 2 — flag ON: balanced split when home is far from one cluster', () => {
  // r1 anchored near south cluster → captures c1-c3.
  // r2 seeded via k-means++ at farthest point → likely c4 or c5, captures north cluster.
  const { byRep } = clusterByHome(REPS_2, CANDIDATES_6, { enableHomeless: true });
  const r1Stops = byRep.get('r1').map((c) => c.id).sort();
  const r2Stops = byRep.get('r2').map((c) => c.id).sort();
  // r1 should get the southern 3, r2 the northern 3.
  assert.deepEqual(r1Stops, ['c1', 'c2', 'c3'], `r1 captures southern cluster`);
  assert.deepEqual(r2Stops, ['c4', 'c5', 'c6'], `r2 captures northern cluster`);
});

test('Cambio 2 — flag ON: all reps homeless = k-means++ partition still works', () => {
  const allHomeless = [
    { id: 'r1', home_lat: null, home_lng: null, employee_code: 'A001' },
    { id: 'r2', home_lat: null, home_lng: null, employee_code: 'A002' },
  ];
  const { byRep, centroidByRepId } = clusterByHome(allHomeless, CANDIDATES_6, { enableHomeless: true });
  const total = byRep.get('r1').length + byRep.get('r2').length;
  assert.equal(total, 6, `All 6 candidates distributed across 2 homeless reps`);
  // Both centroids should be auto-referential.
  assert.equal(centroidByRepId.get('r1').hasHome, false);
  assert.equal(centroidByRepId.get('r2').hasHome, false);
});

test('Cambio 2 — flag ON: empty candidate list with homeless reps does not crash', () => {
  const { byRep } = clusterByHome(REPS_2, [], { enableHomeless: true });
  assert.equal(byRep.get('r1').length, 0);
  assert.equal(byRep.get('r2').length, 0);
});

test('Cambio 2 — centroid is computed as mean of assigned stops (auto-referential)', () => {
  const allHomeless = [
    { id: 'r1', home_lat: null, home_lng: null, employee_code: 'A001' },
  ];
  // 3 stops in a triangle around (19.50, -99.10).
  const stops = [
    { id: 'a', lat: 19.49, lng: -99.10 },
    { id: 'b', lat: 19.51, lng: -99.10 },
    { id: 'c', lat: 19.50, lng: -99.09 },
  ];
  const { centroidByRepId } = clusterByHome(allHomeless, stops, { enableHomeless: true });
  const c = centroidByRepId.get('r1');
  // After convergence, centroid should be near (19.50, -99.0967).
  assert.ok(Math.abs(c.lat - 19.50) < 0.01, `Centroid lat should be ~19.50, got ${c.lat}`);
  assert.ok(Math.abs(c.lng - (-99.0967)) < 0.01, `Centroid lng should be ~-99.0967, got ${c.lng}`);
});

test('Cambio 2 — k-means++ avoids seeding two homeless reps at the same candidate', () => {
  const threeHomeless = [
    { id: 'r1', home_lat: null, home_lng: null, employee_code: 'A001' },
    { id: 'r2', home_lat: null, home_lng: null, employee_code: 'A002' },
    { id: 'r3', home_lat: null, home_lng: null, employee_code: 'A003' },
  ];
  // 9 stops in 3 clear clusters far apart.
  const stops = [];
  for (let i = 0; i < 3; i += 1) stops.push({ id: `cluster_A_${i}`, lat: 19.40 + i * 0.005, lng: -99.10 });
  for (let i = 0; i < 3; i += 1) stops.push({ id: `cluster_B_${i}`, lat: 19.60 + i * 0.005, lng: -99.10 });
  for (let i = 0; i < 3; i += 1) stops.push({ id: `cluster_C_${i}`, lat: 19.50 + i * 0.005, lng: -99.40 });
  const { byRep, centroidByRepId } = clusterByHome(threeHomeless, stops, { enableHomeless: true });
  // Each rep should capture a cluster (centroids should be distinct).
  const centroids = ['r1', 'r2', 'r3'].map((id) => centroidByRepId.get(id));
  // Pair-wise distance between centroids should be > 5km (well-separated).
  for (let i = 0; i < centroids.length; i += 1) {
    for (let j = i + 1; j < centroids.length; j += 1) {
      const d = haversineKm(centroids[i], centroids[j]);
      assert.ok(d > 5, `Centroids r${i + 1} and r${j + 1} should be >5km apart, got ${d.toFixed(2)}km`);
    }
  }
  // Each rep should have ≥ 1 stop.
  for (const r of ['r1', 'r2', 'r3']) {
    assert.ok(byRep.get(r).length >= 1, `${r} should have at least 1 stop`);
  }
});

test('Cambio 2 — flag OFF + no reps with home: degraded round-robin (preserves legacy)', () => {
  const allHomeless = [
    { id: 'r1', home_lat: null, home_lng: null, employee_code: 'A001' },
    { id: 'r2', home_lat: null, home_lng: null, employee_code: 'A002' },
  ];
  const { byRep } = clusterByHome(allHomeless, CANDIDATES_6, { enableHomeless: false });
  // Legacy degraded fallback: round-robin assigns 3 to each.
  assert.equal(byRep.get('r1').length, 3, `Degraded round-robin: r1 gets 3`);
  assert.equal(byRep.get('r2').length, 3, `Degraded round-robin: r2 gets 3`);
});
