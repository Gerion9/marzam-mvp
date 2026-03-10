const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_INPUT_PATH = path.join(ROOT_DIR, 'data', 'farmacias_cliente_ecatepec.csv');
const DEFAULT_OUTPUT_PATH = path.join(ROOT_DIR, 'src', 'public', 'data', 'ecatepec-demo.json');

const DEMO_REP_BLUEPRINTS = [
  {
    user_id: 'rep1',
    full_name: 'Carlos Lopez',
    email: 'carlos@marzam.mx',
    color: '#e11d48',
    campaign_objective: 'Prospecting',
    priority: 'high',
    progress: 0.62,
  },
  {
    user_id: 'rep2',
    full_name: 'Ana Martinez',
    email: 'ana@marzam.mx',
    color: '#2563eb',
    campaign_objective: 'Follow-up',
    priority: 'normal',
    progress: 0.41,
  },
  {
    user_id: 'rep3',
    full_name: 'Miguel Torres',
    email: 'miguel@marzam.mx',
    color: '#10b981',
    campaign_objective: 'Coverage',
    priority: 'urgent',
    progress: 0.53,
  },
];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toText(value) {
  return String(value ?? '').trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).replace(/,/g, '').trim();
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}

function slugify(value) {
  return toText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function formatIsoDate(daysAgo, hourOffset = 0) {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() - daysAgo);
  base.setUTCHours(8 + hourOffset, 0, 0, 0);
  return base.toISOString();
}

function parsePointWkt(value) {
  const match = toText(value).match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!match) return null;
  return {
    lng: Number.parseFloat(match[1]),
    lat: Number.parseFloat(match[2]),
  };
}

function buildAddress(row) {
  const parts = [
    row.address,
    row.address2,
    row.neighborhood,
    row.city,
    row.state,
    row.postal_code,
  ]
    .map(toText)
    .filter(Boolean);

  return [...new Set(parts)].join(', ');
}

function buildOpeningHours(row) {
  const first = toText(row.monday_open) || toText(row.tuesday_open) || toText(row.wednesday_open);
  const last = toText(row.monday_close) || toText(row.tuesday_close) || toText(row.wednesday_close);
  if (!first && !last) return null;
  return [first, last].filter(Boolean).join(' - ');
}

function deriveStatus(row, classification) {
  const openClosed = toText(row.open_closed_status).toLowerCase();
  if (openClosed === 'closed') return 'closed';
  if (classification === 'mislabeled_pharmacy') return 'pending_review';
  return 'active';
}

function deriveVerificationStatus(classification, confidence, validity) {
  if (classification === 'mislabeled_pharmacy') return 'flagged';
  if (classification === 'false_chain_tag') return 'flagged';
  if (confidence >= 0.8 || validity >= 0.8) return 'verified';
  return 'unverified';
}

function derivePotentialScore({ popularity, confidence, validity, reviews, stars }) {
  const popularityScore = clamp((popularity || 0) * 42, 0, 42);
  const confidenceScore = clamp((Math.max(confidence || 0, validity || 0)) * 26, 0, 26);
  const reviewsScore = clamp(Math.log10((reviews || 0) + 1) * 12, 0, 18);
  const starsScore = clamp(((stars || 0) / 5) * 14, 0, 14);
  return Math.round(clamp(popularityScore + confidenceScore + reviewsScore + starsScore, 10, 99));
}

function deriveOrderPotential(potentialScore, reviews, stars) {
  const base = 1200;
  return Math.round(base + potentialScore * 115 + (reviews || 0) * 18 + (stars || 0) * 320);
}

function buildNaturalKey(pharmacy) {
  return [
    slugify(pharmacy.name),
    slugify(pharmacy.address),
    Number(pharmacy.lat).toFixed(4),
    Number(pharmacy.lng).toFixed(4),
  ].join('|');
}

function parseCoordinates(row) {
  const latitude = toNumber(row.latitude);
  const longitude = toNumber(row.longitude);
  if (latitude !== null && longitude !== null) {
    return { lat: latitude, lng: longitude };
  }
  return parsePointWkt(row.geometry_coords);
}

function normalizePharmacyRow(row, index) {
  const coords = parseCoordinates(row);
  const name = toText(row.name);
  if (!coords || !name) return null;

  const classification = toText(row.chain_classification).toLowerCase();
  const confidence = clamp(toNumber(row.data_quality_confidence_score) ?? 0.68, 0, 1);
  const validity = clamp(toNumber(row.validity_score) ?? confidence, 0, 1);
  const reviews = Math.max(0, Math.round(toNumber(row.number_of_reviews) ?? 0));
  const stars = clamp(toNumber(row.average_stars) ?? 0, 0, 5);
  const popularity = clamp(toNumber(row.popularity_score) ?? 0, 0, 1);
  const potentialScore = derivePotentialScore({ popularity, confidence, validity, reviews, stars });
  const openingHours = buildOpeningHours(row);
  const address = buildAddress(row);
  const status = deriveStatus(row, classification);
  const website = toText(row.website) || null;
  const notes = [
    toText(row.classification_reason),
    website ? `Website: ${website}` : '',
  ].filter(Boolean).join(' | ') || null;

  return {
    id: `eco_${String(index + 1).padStart(4, '0')}`,
    name,
    chain: toText(row.chain_name_clean) || null,
    municipality: toText(row.city || row.nomgeo) || 'Ecatepec de Morelos',
    state: toText(row.state) || 'Estado de Mexico',
    address,
    status,
    verification_status: deriveVerificationStatus(classification, confidence, validity),
    is_independent: classification === 'independent',
    potential_score: potentialScore,
    order_potential: deriveOrderPotential(potentialScore, reviews, stars),
    contact_phone: toText(row.phone) || null,
    contact_person: null,
    lat: Number(coords.lat.toFixed(6)),
    lng: Number(coords.lng.toFixed(6)),
    source: 'blackprint',
    category: toText(row.main_category) || 'pharmacy',
    subcategory: toText(row.sub_category) || null,
    num_reviews: reviews,
    popularity_score: Number(popularity.toFixed(2)),
    data_confidence_score: Number(confidence.toFixed(2)),
    opening_hours: openingHours,
    closing_hours: openingHours,
    website,
    notes,
    last_visit_outcome: null,
    last_visited_at: null,
    assigned_rep_id: null,
    metadata: {
      cve_ent: toText(row.cve_ent) || null,
      cve_mun: toText(row.cve_mun) || null,
      neighborhood: toText(row.neighborhood) || null,
      postal_code: toText(row.postal_code) || null,
      open_closed_status: toText(row.open_closed_status) || null,
      chain_classification: classification || null,
      classification_reason: toText(row.classification_reason) || null,
      geometry_coords: toText(row.geometry_coords) || null,
    },
  };
}

function readRawRows(inputPath = DEFAULT_INPUT_PATH) {
  const csvContents = fs.readFileSync(inputPath, 'utf8');
  const workbook = XLSX.read(csvContents, { raw: false, type: 'string' });
  const firstSheet = workbook.SheetNames[0];
  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '' });
}

function normalizePharmacies(rows) {
  const seen = new Set();
  const normalized = [];

  rows.forEach((row, index) => {
    const pharmacy = normalizePharmacyRow(row, index);
    if (!pharmacy) return;
    const naturalKey = buildNaturalKey(pharmacy);
    if (seen.has(naturalKey)) return;
    seen.add(naturalKey);
    normalized.push(pharmacy);
  });

  return normalized.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const radiusKm = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeCentroid(points) {
  if (!points.length) return { lat: 19.617, lng: -99.05 };
  const aggregate = points.reduce((acc, point) => {
    acc.lat += point.lat;
    acc.lng += point.lng;
    return acc;
  }, { lat: 0, lng: 0 });
  return {
    lat: aggregate.lat / points.length,
    lng: aggregate.lng / points.length,
  };
}

function buildBoundingPolygon(points, padding = 0.012) {
  const lngs = points.map((point) => point.lng);
  const lats = points.map((point) => point.lat);
  const minLng = Math.min(...lngs) - padding;
  const maxLng = Math.max(...lngs) + padding;
  const minLat = Math.min(...lats) - padding;
  const maxLat = Math.max(...lats) + padding;

  return {
    type: 'Polygon',
    coordinates: [[
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat],
    ]],
  };
}

function orderStopsFromOrigin(stops, origin) {
  const ordered = [];
  const pending = [...stops];
  let anchor = { lat: origin.lat, lng: origin.lng };

  while (pending.length) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < pending.length; index += 1) {
      const candidate = pending[index];
      const distance = haversineKm(anchor.lat, anchor.lng, candidate.lat, candidate.lng);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    const [nextStop] = pending.splice(bestIndex, 1);
    ordered.push(nextStop);
    anchor = { lat: nextStop.lat, lng: nextStop.lng };
  }

  return ordered;
}

function samplePolyline(points, progress) {
  if (!points.length) return null;
  if (points.length === 1) return { ...points[0] };

  const segments = [];
  let totalDistance = 0;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentDistance = haversineKm(start.lat, start.lng, end.lat, end.lng);
    totalDistance += segmentDistance;
    segments.push({ start, end, segmentDistance });
  }

  if (totalDistance === 0) return { ...points[points.length - 1] };

  let travelled = clamp(progress, 0, 1) * totalDistance;
  for (const segment of segments) {
    if (travelled <= segment.segmentDistance) {
      const localProgress = segment.segmentDistance === 0 ? 0 : travelled / segment.segmentDistance;
      return {
        lat: Number((segment.start.lat + (segment.end.lat - segment.start.lat) * localProgress).toFixed(6)),
        lng: Number((segment.start.lng + (segment.end.lng - segment.start.lng) * localProgress).toFixed(6)),
      };
    }
    travelled -= segment.segmentDistance;
  }

  return { ...points[points.length - 1] };
}

function buildBreadcrumbs(routePoints, progress, repIndex) {
  const sampleCount = 28;
  const startedDaysAgo = 2 - repIndex;
  const timestamps = [];
  const baseDate = new Date();
  baseDate.setUTCDate(baseDate.getUTCDate() - Math.max(startedDaysAgo, 0));
  baseDate.setUTCHours(8, 15 + repIndex * 12, 0, 0);

  for (let index = 0; index < sampleCount; index += 1) {
    const ratio = sampleCount === 1 ? progress : (progress * index) / (sampleCount - 1);
    const sampledPoint = samplePolyline(routePoints, ratio);
    if (!sampledPoint) continue;
    const timestamp = new Date(baseDate.getTime() + index * 14 * 60 * 1000);
    timestamps.push({
      lat: sampledPoint.lat,
      lng: sampledPoint.lng,
      recorded_at: timestamp.toISOString(),
      accuracy_meters: 8 + (index % 5) * 3,
    });
  }

  return timestamps;
}

function buildVisitOutcome(index, repIndex) {
  const matrix = [
    ['interested', 'contact_made', 'needs_follow_up', 'visited', 'interested'],
    ['contact_made', 'interested', 'visited', 'needs_follow_up', 'contact_made'],
    ['visited', 'contact_made', 'interested', 'visited', 'needs_follow_up'],
  ];
  return matrix[repIndex][index % matrix[repIndex].length];
}

function createDemoDataset(pharmacies) {
  const activeCandidates = pharmacies.filter((pharmacy) => pharmacy.status !== 'closed');
  const sortedByLng = [...activeCandidates].sort((left, right) => left.lng - right.lng);
  const seedFractions = [0.18, 0.5, 0.82];

  const repSeeds = DEMO_REP_BLUEPRINTS.map((rep, index) => {
    const seed = sortedByLng[Math.min(sortedByLng.length - 1, Math.floor(sortedByLng.length * seedFractions[index]))];
    return {
      ...rep,
      seed: { lat: seed?.lat ?? 19.617, lng: seed?.lng ?? -99.05 },
    };
  });

  const groups = new Map(repSeeds.map((rep) => [rep.user_id, []]));
  activeCandidates.forEach((pharmacy) => {
    let targetRep = repSeeds[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    repSeeds.forEach((rep) => {
      const distance = haversineKm(pharmacy.lat, pharmacy.lng, rep.seed.lat, rep.seed.lng);
      if (distance < bestDistance) {
        bestDistance = distance;
        targetRep = rep;
      }
    });
    groups.get(targetRep.user_id).push(pharmacy);
  });

  const assignments = [];
  const reps = [];
  const visits = [];
  const commercialLeads = [];
  const auditEvents = [];
  const reviewItems = [];
  const breadcrumbsByRep = {};
  const pharmacyById = new Map(pharmacies.map((pharmacy) => [pharmacy.id, pharmacy]));

  repSeeds.forEach((rep, repIndex) => {
    const group = groups.get(rep.user_id) || [];
    const centroid = computeCentroid(group.length ? group : activeCandidates);
    const rankedStops = [...group]
      .sort((left, right) => {
        const leftDistance = haversineKm(left.lat, left.lng, centroid.lat, centroid.lng);
        const rightDistance = haversineKm(right.lat, right.lng, centroid.lat, centroid.lng);
        if (leftDistance !== rightDistance) return leftDistance - rightDistance;
        return right.potential_score - left.potential_score;
      })
      .slice(0, 16);

    const orderedStops = orderStopsFromOrigin(rankedStops, rep.seed);
    const completedCount = Math.min([5, 3, 4][repIndex], orderedStops.length);
    const routePoints = [
      { lat: rep.seed.lat, lng: rep.seed.lng },
      ...orderedStops.map((stop) => ({ lat: stop.lat, lng: stop.lng })),
    ];
    const trail = buildBreadcrumbs(routePoints, rep.progress, repIndex);
    const currentPoint = trail[trail.length - 1] || { lat: rep.seed.lat, lng: rep.seed.lng };
    const stopStatuses = {};

    orderedStops.forEach((stop, index) => {
      stop.assigned_rep_id = rep.user_id;
      if (index < completedCount) {
        stopStatuses[stop.id] = 'completed';
      }
    });

    const assignment = {
      id: `a_eco_${repIndex + 1}`,
      campaign_objective: rep.campaign_objective,
      status: 'in_progress',
      priority: rep.priority,
      rep_id: rep.user_id,
      rep_name: rep.full_name,
      due_date: formatIsoDate(-(repIndex + 2), repIndex),
      visit_goal: orderedStops.length,
      pharmacy_count: orderedStops.length,
      completed_stops: completedCount,
      total_stops: orderedStops.length,
      pharmacy_ids: orderedStops.map((stop) => stop.id),
      stop_statuses: stopStatuses,
      polygon_geojson: buildBoundingPolygon(orderedStops.length ? orderedStops : [rep.seed]),
    };

    assignments.push(assignment);
    breadcrumbsByRep[rep.user_id] = trail;
    reps.push({
      user_id: rep.user_id,
      full_name: rep.full_name,
      email: rep.email,
      color: rep.color,
      last_lat: currentPoint.lat,
      last_lng: currentPoint.lng,
      last_seen: trail[trail.length - 1]?.recorded_at || new Date().toISOString(),
      total_visits: 0,
      interested_count: 0,
      unique_pharmacies: 0,
      home_lat: rep.seed.lat,
      home_lng: rep.seed.lng,
    });

    auditEvents.push({
      id: `ae_assignment_${repIndex + 1}`,
      action: 'assignment.created',
      entity_type: 'assignment',
      entity_id: assignment.id,
      user_name: 'Demo Manager',
      created_at: formatIsoDate(4 - repIndex, repIndex),
    });

    for (let visitIndex = 0; visitIndex < completedCount; visitIndex += 1) {
      const pharmacy = pharmacyById.get(orderedStops[visitIndex].id);
      if (!pharmacy) continue;

      const createdAt = formatIsoDate(3 - repIndex, repIndex + visitIndex);
      const outcome = buildVisitOutcome(visitIndex, repIndex);
      const visitId = `v_${rep.user_id}_${visitIndex + 1}`;

      pharmacy.last_visit_outcome = outcome;
      pharmacy.last_visited_at = createdAt;
      pharmacy.contact_person = pharmacy.contact_person || `${rep.full_name.split(' ')[0]} Contact`;

      visits.push({
        id: visitId,
        pharmacy_id: pharmacy.id,
        rep_id: rep.user_id,
        outcome,
        notes: `Demo visit captured for ${pharmacy.name}.`,
        order_potential: pharmacy.order_potential,
        contact_person: pharmacy.contact_person,
        contact_phone: pharmacy.contact_phone,
        competitor_products: visitIndex % 2 === 0 ? 'Genomma Lab, Bayer OTC' : 'Sanofi, Pisa',
        stock_observations: visitIndex % 2 === 0 ? 'Medium rotation inventory.' : 'Fast moving OTC shelf.',
        follow_up_date: outcome === 'needs_follow_up' ? formatIsoDate(-2, repIndex + visitIndex) : undefined,
        follow_up_reason: outcome === 'needs_follow_up' ? 'Needs price confirmation' : undefined,
        created_at: createdAt,
      });

      auditEvents.push({
        id: `ae_visit_${rep.user_id}_${visitIndex + 1}`,
        action: 'visit.submitted',
        entity_type: 'visit',
        entity_id: visitId,
        user_name: rep.full_name,
        created_at: createdAt,
      });

      if (outcome === 'interested') {
        commercialLeads.push({
          id: `cl_${rep.user_id}_${visitIndex + 1}`,
          pharmacy_id: pharmacy.id,
          visit_id: visitId,
          status: visitIndex % 2 === 0 ? 'interested' : 'follow_up_required',
          potential_sales: pharmacy.order_potential,
          contact_person: pharmacy.contact_person,
          contact_phone: pharmacy.contact_phone,
          notes: 'Lead created from Ecatepec demo dataset.',
          created_at: createdAt,
        });
      }
    }
  });

  const reviewCandidates = pharmacies
    .filter((pharmacy) => pharmacy.status === 'pending_review' || pharmacy.verification_status === 'flagged')
    .slice(0, 3);

  reviewCandidates.forEach((pharmacy, index) => {
    const owner = reps[index % reps.length];
    reviewItems.push({
      id: `rv_eco_${index + 1}`,
      pharmacy_id: pharmacy.id,
      pharmacy_name: pharmacy.name,
      flag_type: pharmacy.verification_status === 'flagged' ? 'classification_flag' : 'new_pharmacy',
      reason: pharmacy.notes || 'Requires manager validation before production sync.',
      queue_status: 'pending',
      submitted_by: owner.user_id,
      rep_name: owner.full_name,
      pharmacy_lat: pharmacy.lat,
      pharmacy_lng: pharmacy.lng,
      created_at: formatIsoDate(1, index),
    });
  });

  reps.forEach((rep) => {
    const repVisits = visits.filter((visit) => visit.rep_id === rep.user_id);
    rep.total_visits = repVisits.length;
    rep.interested_count = repVisits.filter((visit) => visit.outcome === 'interested').length;
    rep.unique_pharmacies = new Set(repVisits.map((visit) => visit.pharmacy_id)).size;
  });

  return {
    meta: {
      generated_at: new Date().toISOString(),
      source_file: path.relative(ROOT_DIR, DEFAULT_INPUT_PATH).replace(/\\/g, '/'),
      pharmacy_count: pharmacies.length,
      assigned_pharmacy_count: pharmacies.filter((pharmacy) => pharmacy.assigned_rep_id).length,
      review_count: reviewItems.length,
    },
    pharmacies,
    reps,
    assignments,
    reviewItems,
    visits,
    commercialLeads,
    auditEvents,
    breadcrumbsByRep,
  };
}

function toDatabaseRecord(pharmacy) {
  return {
    name: pharmacy.name,
    address: pharmacy.address,
    category: pharmacy.category,
    subcategory: pharmacy.subcategory,
    municipality: pharmacy.municipality,
    state: pharmacy.state,
    contact_phone: pharmacy.contact_phone,
    contact_person: pharmacy.contact_person,
    opening_hours: pharmacy.opening_hours,
    closing_hours: pharmacy.closing_hours,
    num_reviews: pharmacy.num_reviews,
    popularity_score: Number((pharmacy.popularity_score ?? 0).toFixed(2)),
    data_confidence_score: Number((pharmacy.data_confidence_score ?? 0).toFixed(2)),
    is_independent: pharmacy.is_independent,
    status: pharmacy.status,
    verification_status: pharmacy.verification_status,
    order_potential: pharmacy.order_potential,
    notes: pharmacy.notes,
    source: 'blackprint',
    lat: pharmacy.lat,
    lng: pharmacy.lng,
  };
}

module.exports = {
  DEFAULT_INPUT_PATH,
  DEFAULT_OUTPUT_PATH,
  DEMO_REP_BLUEPRINTS,
  readRawRows,
  normalizePharmacies,
  createDemoDataset,
  toDatabaseRecord,
  buildNaturalKey,
};
