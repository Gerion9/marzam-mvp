function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function buildSemanticMap(schemaColumns, candidateMap, explicitMap = {}) {
  const normalized = new Map(schemaColumns.map((column) => [normalizeKey(column), column]));
  const resolved = {};

  for (const [semanticKey, explicitValue] of Object.entries(explicitMap || {})) {
    if (explicitValue && normalized.has(normalizeKey(explicitValue))) {
      resolved[semanticKey] = normalized.get(normalizeKey(explicitValue));
    }
  }

  for (const [semanticKey, candidates] of Object.entries(candidateMap)) {
    if (resolved[semanticKey]) continue;
    const match = candidates.find((candidate) => normalized.has(normalizeKey(candidate)));
    if (match) resolved[semanticKey] = normalized.get(normalizeKey(match));
  }

  return resolved;
}

function pickExistingColumns(record, semanticMap) {
  const payload = {};
  for (const [semanticKey, columnName] of Object.entries(semanticMap)) {
    if (columnName && record[semanticKey] !== undefined) {
      payload[columnName] = record[semanticKey];
    }
  }
  return payload;
}

function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function mapRawRow(rawRow, semanticMap) {
  const normalized = {};
  for (const [semanticKey, columnName] of Object.entries(semanticMap)) {
    normalized[semanticKey] = rawRow?.[columnName];
  }
  return normalized;
}

function pointInPolygon(lng, lat, polygon) {
  if (!polygon?.coordinates?.[0]?.length) return false;
  const ring = polygon.coordinates[0];
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = ((yi > lat) !== (yj > lat))
      && (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }

  return inside;
}

function polygonBounds(polygon) {
  const ring = polygon?.coordinates?.[0] || [];
  const lngs = ring.map((coord) => coord[0]);
  const lats = ring.map((coord) => coord[1]);
  return {
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
  };
}

module.exports = {
  buildSemanticMap,
  pickExistingColumns,
  mapRawRow,
  coerceNumber,
  pointInPolygon,
  polygonBounds,
};
