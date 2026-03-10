/**
 * Balanced spatial clustering for pharmacy distribution.
 *
 * Algorithm: k-means-style with size balancing.
 * 1. Seed k centroids via grid partitioning of the bounding box.
 * 2. Assign each pharmacy to nearest centroid, respecting a max-size cap.
 * 3. Recompute centroids from assigned members.
 * 4. Repeat until stable or max iterations reached.
 * 5. Final pass: steal from oversized clusters to fill undersized ones.
 */

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function seedCentroids(points, k) {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const cols = Math.ceil(Math.sqrt(k * ((maxLng - minLng) / (maxLat - minLat + 1e-9))));
  const rows = Math.ceil(k / cols);

  const centroids = [];
  const latStep = (maxLat - minLat) / rows;
  const lngStep = (maxLng - minLng) / cols;

  for (let r = 0; r < rows && centroids.length < k; r++) {
    for (let c = 0; c < cols && centroids.length < k; c++) {
      centroids.push({
        lat: minLat + latStep * (r + 0.5),
        lng: minLng + lngStep * (c + 0.5),
      });
    }
  }

  while (centroids.length < k) {
    centroids.push({ ...centroids[centroids.length - 1] });
  }

  return centroids;
}

function assignBalanced(points, centroids, maxPerCluster) {
  const k = centroids.length;
  const clusters = Array.from({ length: k }, () => []);

  const distances = points.map((p) =>
    centroids.map((c, ci) => ({ ci, dist: haversineKm(p.lat, p.lng, c.lat, c.lng) }))
      .sort((a, b) => a.dist - b.dist),
  );

  const indices = distances.map((_, i) => i);
  indices.sort((a, b) => distances[a][0].dist - distances[b][0].dist);

  const assigned = new Set();

  for (const pi of indices) {
    if (assigned.has(pi)) continue;
    for (const { ci } of distances[pi]) {
      if (clusters[ci].length < maxPerCluster) {
        clusters[ci].push(points[pi]);
        assigned.add(pi);
        break;
      }
    }
  }

  for (let pi = 0; pi < points.length; pi++) {
    if (!assigned.has(pi)) {
      let bestCI = 0;
      let bestSize = Infinity;
      for (let ci = 0; ci < k; ci++) {
        if (clusters[ci].length < bestSize) {
          bestSize = clusters[ci].length;
          bestCI = ci;
        }
      }
      clusters[bestCI].push(points[pi]);
    }
  }

  return clusters;
}

function recomputeCentroids(clusters) {
  return clusters.map((members) => {
    if (!members.length) return { lat: 0, lng: 0 };
    const sumLat = members.reduce((s, p) => s + p.lat, 0);
    const sumLng = members.reduce((s, p) => s + p.lng, 0);
    return { lat: sumLat / members.length, lng: sumLng / members.length };
  });
}

function balancePass(clusters, targetSize) {
  const overIdx = [];
  const underIdx = [];
  for (let i = 0; i < clusters.length; i++) {
    if (clusters[i].length > targetSize + 1) overIdx.push(i);
    else if (clusters[i].length < targetSize - 1) underIdx.push(i);
  }

  for (const ui of underIdx) {
    const centroid = recomputeCentroids([clusters[ui]])[0];
    while (clusters[ui].length < targetSize) {
      let bestDist = Infinity;
      let bestOI = -1;
      let bestPI = -1;

      for (const oi of overIdx) {
        if (clusters[oi].length <= targetSize) continue;
        for (let pi = 0; pi < clusters[oi].length; pi++) {
          const d = haversineKm(clusters[oi][pi].lat, clusters[oi][pi].lng, centroid.lat, centroid.lng);
          if (d < bestDist) {
            bestDist = d;
            bestOI = oi;
            bestPI = pi;
          }
        }
      }

      if (bestOI === -1) break;
      clusters[ui].push(clusters[bestOI].splice(bestPI, 1)[0]);
    }
  }

  return clusters;
}

function balancedSpatialClusters(points, k, maxIterations = 12) {
  if (!points.length || k <= 0) return [];
  if (k === 1) return [points];
  if (points.length <= k) return points.map((p) => [p]);

  const validPoints = points.filter((p) =>
    Number.isFinite(p.lat) && Number.isFinite(p.lng));

  const targetSize = Math.ceil(validPoints.length / k);
  const maxPerCluster = targetSize + Math.ceil(targetSize * 0.15);

  let centroids = seedCentroids(validPoints, k);
  let clusters;

  for (let iter = 0; iter < maxIterations; iter++) {
    clusters = assignBalanced(validPoints, centroids, maxPerCluster);
    const newCentroids = recomputeCentroids(clusters);

    let totalShift = 0;
    for (let i = 0; i < k; i++) {
      totalShift += haversineKm(centroids[i].lat, centroids[i].lng, newCentroids[i].lat, newCentroids[i].lng);
    }

    centroids = newCentroids;
    if (totalShift < 0.01) break;
  }

  clusters = balancePass(clusters, targetSize);

  return clusters.filter((c) => c.length > 0);
}

function clusterStats(clusters) {
  const sizes = clusters.map((c) => c.length);
  const total = sizes.reduce((s, n) => s + n, 0);
  const dispersions = clusters.map((members) => {
    if (members.length <= 1) return 0;
    const centroid = recomputeCentroids([members])[0];
    const distances = members.map((p) => haversineKm(p.lat, p.lng, centroid.lat, centroid.lng));
    return Math.max(...distances);
  });

  return {
    cluster_count: clusters.length,
    total_points: total,
    min_size: Math.min(...sizes),
    max_size: Math.max(...sizes),
    avg_size: Number((total / clusters.length).toFixed(1)),
    max_dispersion_km: Number(Math.max(...dispersions).toFixed(2)),
    avg_dispersion_km: Number((dispersions.reduce((s, d) => s + d, 0) / dispersions.length).toFixed(2)),
  };
}

module.exports = { balancedSpatialClusters, clusterStats, haversineKm };
