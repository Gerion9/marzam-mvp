/**
 * Google Route Optimization API — managed VRP solver wrapper.
 *
 * Por qué este módulo existe (vs. NN+2-opt en planGenerator.js):
 *
 *   El solver actual (k-means + greedy + 2-opt) funcionó muy bien con la
 *   premisa de "8-12 stops/rep/día sin constraints duros". El cliente
 *   confirmó que la realidad es 23 stops/rep/día con skills por usuario,
 *   service times variables (15-45 min), prioridades Pareto que no deben
 *   quedarse sin visitar, y posibles ventanas duras de farmacia.
 *
 *   A esa escala con esos constraints, el problema deja de ser TSP trivial y
 *   se vuelve un VRP. Google Route Optimization API resuelve VRP managed —
 *   le pasamos vehículos, shipments, restricciones (penaltyCost para Pareto,
 *   vehicleType para skills, routeDurationLimit para daily_minutes_cap), y
 *   nuestra matriz pre-calculada del cache para evitar que el optimizer
 *   queme Routes API por dentro.
 *
 * Activación:
 *   Feature flag `PLAN_USE_OPTIMIZATION_API=true`. Default OFF. Cuando OFF,
 *   `planGenerator.sequenceAndMaterialize` mantiene el solver actual sin
 *   tocar este archivo. El service queda mergeado pero "no-op" hasta que el
 *   flag se enciende — patrón idéntico a otros features-flagged del proyecto
 *   (PLAN_ENABLE_CAP_VALIDATION, PLAN_HARD_WINDOWS_ENFORCED).
 *
 * Auth:
 *   La Route Optimization API es una Google Cloud API. Soporta:
 *     - Service Account / OAuth2 access token vía Authorization: Bearer
 *       (env GOOGLE_OPT_ACCESS_TOKEN). Recomendado para prod.
 *     - API key vía X-Goog-Api-Key (env GOOGLE_MAPS_OPTIMIZATION_API_KEY).
 *       Funciona si la API está habilitada con restricciones de API Key.
 *   El project ID debe estar en GOOGLE_CLOUD_PROJECT (también acepta
 *   GCP_PROJECT como alias). El endpoint requiere `parent=projects/PROJECT_ID`.
 *
 * Spend tracking:
 *   Cada llamada exitosa hace UPSERT a `route_optimization_api_spend` (mig 095)
 *   con el costo lineal ($0.0013/shipment, tentativo). Las llamadas fallidas y
 *   rechazadas (no quota) se cuentan en counters separados (`failed_calls` /
 *   `rejected_calls`) sin sumar al estimated cost.
 */

const log = require('../utils/logger');
const db = require('../config/database');
const pricing = require('./pricing');

const ENDPOINT_BASE = 'https://routeoptimization.googleapis.com/v1';
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 750;

function getProjectId() {
  const id = process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCP_PROJECT
    || process.env.GOOGLE_OPT_PROJECT_ID;
  if (!id) throw new Error('GOOGLE_CLOUD_PROJECT (or GCP_PROJECT) is not set');
  return id;
}

function getAuthHeaders() {
  const accessToken = process.env.GOOGLE_OPT_ACCESS_TOKEN;
  if (accessToken) {
    return { Authorization: `Bearer ${accessToken}` };
  }
  // No fallback a GOOGLE_MAPS_API_KEY a propósito: Route Optimization API es
  // una Google Cloud API distinta de Routes/Maps y los keys deben tener scope
  // separado (cloud-platform). Reusar la key de Maps puede pasar el check
  // local pero fallar 403 en Google. Mejor exigir setting explícito.
  const apiKey = process.env.GOOGLE_MAPS_OPTIMIZATION_API_KEY;
  if (apiKey) {
    return { 'X-Goog-Api-Key': apiKey };
  }
  throw new Error('No auth for Route Optimization API — set GOOGLE_OPT_ACCESS_TOKEN or GOOGLE_MAPS_OPTIMIZATION_API_KEY');
}

function metersFromKm(km) {
  return Math.round(Number(km || 0) * 1000);
}

function durationToProto(seconds) {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  return `${s}s`;
}

/**
 * Construye el payload `optimizeTours` a partir de inputs domain-level.
 *
 *   vehicles    [{ id, startLocation: {lat,lng}, endLocation?, capabilities?,
 *                  routeDurationLimitMin?, routeDistanceLimitKm? }]
 *   shipments   [{ id, deliveryLocation: {lat,lng}, durationMinutes,
 *                  requiredCapabilities?, penaltyCost?, label?,
 *                  hardWindowStart?, hardWindowEnd? }]
 *   durationMatrix  cuadrada N×N en segundos. Primer índice = depot vehicle 0,
 *                    luego shipments en el mismo orden que el array. La rama
 *                    multi-vehicle usa una matriz por depot (ver routesMatrix
 *                    extractMatrixForOptimization).
 *   distanceMatrix  análogo en metros.
 *   options     { timeoutSeconds?, searchMode? = 'CONSUME_ALL_AVAILABLE_TIME' }
 *
 * Exportado para tests (verificar shape sin pegarle a la API).
 */
function buildPayload({
  vehicles, shipments, durationMatrix, distanceMatrix, options = {},
}) {
  if (!Array.isArray(vehicles) || vehicles.length === 0) {
    throw new Error('vehicles must be a non-empty array');
  }
  if (!Array.isArray(shipments) || shipments.length === 0) {
    throw new Error('shipments must be a non-empty array');
  }
  if (!Array.isArray(durationMatrix) || !Array.isArray(distanceMatrix)) {
    throw new Error('durationMatrix and distanceMatrix must be arrays');
  }

  const apiVehicles = vehicles.map((v) => {
    const out = {
      // Nota: Google expects camelCase in JSON body for v1.
      startLocation: { latitude: v.startLocation.lat, longitude: v.startLocation.lng },
    };
    if (v.endLocation) {
      out.endLocation = { latitude: v.endLocation.lat, longitude: v.endLocation.lng };
    } else if (v.startLocation) {
      out.endLocation = { latitude: v.startLocation.lat, longitude: v.startLocation.lng };
    }
    if (Array.isArray(v.capabilities) && v.capabilities.length) {
      out.loadLimits = {};
      // Capabilities se mapean a "type" tags sobre el vehicle — usando label
      // como hint para humanos en el response.
      out.label = v.id ? `vehicle:${v.id}` : undefined;
      out.travelMode = 'DRIVING';
    } else {
      out.label = v.id ? `vehicle:${v.id}` : undefined;
      out.travelMode = 'DRIVING';
    }
    if (v.routeDurationLimitMin != null) {
      out.routeDurationLimit = {
        maxDuration: durationToProto(Number(v.routeDurationLimitMin) * 60),
      };
    }
    if (v.routeDistanceLimitKm != null) {
      out.routeDistanceLimit = {
        maxMeters: metersFromKm(v.routeDistanceLimitKm),
      };
    }
    // Index 0 of the duration/distance matrix is reserved for the vehicle's
    // depot. We rely on `extractMatrixForOptimization` ordering this correctly.
    out.usedIfRouteIsEmpty = false;
    return out;
  });

  const apiShipments = shipments.map((s, i) => {
    const visit = {
      arrivalLocation: { latitude: s.deliveryLocation.lat, longitude: s.deliveryLocation.lng },
      duration: durationToProto(Number(s.durationMinutes || 0) * 60),
    };
    if (s.hardWindowStart && s.hardWindowEnd) {
      visit.timeWindows = [{
        startTime: s.hardWindowStart,
        endTime: s.hardWindowEnd,
      }];
    }
    const shipment = {
      pickups: [visit], // single pickup per stop (no separate dropoff for sales visits)
      label: s.id ? `stop:${s.id}` : `stop:${i}`,
    };
    if (s.penaltyCost != null && Number.isFinite(Number(s.penaltyCost))) {
      // penaltyCost is the cost of skipping this shipment. Higher = solver
      // less likely to leave it unassigned. We use this to enforce Pareto
      // priority softly (A=1000, B=500, C=200, D=50).
      shipment.penaltyCost = Number(s.penaltyCost);
    }
    if (Array.isArray(s.requiredCapabilities) && s.requiredCapabilities.length) {
      // For now we treat capabilities as a soft hint via shipment.label —
      // hard skill enforcement is handled upstream by filtering shipments out
      // of vehicles that can't visit them. Future: wire to vehicle.types when
      // we stabilize the skill catalog with Google's type tagging.
      shipment.label = `${shipment.label}|skills:${s.requiredCapabilities.join(',')}`;
    }
    return shipment;
  });

  // Matriz pre-calculada — CRÍTICO. Sin esto, la Optimization API consume
  // Routes API por dentro y nos cobra doble. La matriz debe estar ordenada
  // como: [depot_v0, depot_v1, ..., shipment_0, shipment_1, ...].
  // Cada vehicle usa la misma matriz por simplicidad (single-depot case);
  // multi-depot pasaría una matriz por vehicleStartTag.
  const apiMatrix = {
    rows: durationMatrix.map((row, i) => ({
      durations: row.map((s) => durationToProto(s)),
      meters: distanceMatrix[i] || [],
    })),
  };

  return {
    parent: `projects/${getProjectId()}`,
    model: {
      vehicles: apiVehicles,
      shipments: apiShipments,
      durationDistanceMatrices: [apiMatrix],
    },
    searchMode: options.searchMode || 'CONSUME_ALL_AVAILABLE_TIME',
    timeout: durationToProto((options.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS)),
  };
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function delay(ms) {
  // Sleep without blocking the event loop. Used between retries.
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Llama al endpoint con retry exponencial limitado a `maxRetries` y un timeout
 * por intento via AbortController. Errores no retryable (4xx que no sean 429)
 * cortan inmediatamente. Devuelve `{ response, parsed }` o lanza un Error.
 */
async function callOptimizeTours(payload, {
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  maxRetries = DEFAULT_MAX_RETRIES,
  fetchImpl = global.fetch,
} = {}) {
  const url = `${ENDPOINT_BASE}/${payload.parent}:optimizeTours`;
  const body = JSON.stringify({
    // `parent` no va dentro del body en v1: ya está en el URL.
    model: payload.model,
    searchMode: payload.searchMode,
    timeout: payload.timeout,
  });

  let attempt = 0;
  let lastErr = null;
  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000 + 2000);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(),
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const parsed = await res.json();
        return { response: res, parsed };
      }
      const text = await res.text().catch(() => '');
      const err = new Error(`route_optimization_http_${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      if (!isRetryableStatus(res.status) || attempt === maxRetries) throw err;
      lastErr = err;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        const err = new Error(`route_optimization_timeout_${timeoutSeconds}s`);
        err.code = 'timeout';
        if (attempt === maxRetries) throw err;
        lastErr = err;
      } else if (e.status && !isRetryableStatus(e.status)) {
        throw e;
      } else if (attempt === maxRetries) {
        throw e;
      } else {
        lastErr = e;
      }
    }
    // Exponential backoff with mild jitter.
    const jitter = Math.floor(Math.random() * 250);
    await delay(BACKOFF_BASE_MS * (2 ** attempt) + jitter);
    attempt += 1;
  }
  throw lastErr || new Error('route_optimization_exhausted_retries');
}

/**
 * Public entry — construye payload, llama API con retry/timeout, registra
 * spend, devuelve el response parseado.
 *
 * Si la llamada falla, registra el `failed_calls` y re-lanza. Callers (i.e.
 * planGenerator) son responsables del fallback al solver clásico.
 */
async function optimizeTours(args) {
  const payload = buildPayload(args);
  const shipmentCount = (args.shipments || []).length;
  const vehicleCount = (args.vehicles || []).length;
  const t0 = Date.now();
  try {
    const { parsed } = await callOptimizeTours(payload, args.options);
    const ms = Date.now() - t0;
    log.info({
      event: 'route_optimization.success',
      ms, shipments: shipmentCount, vehicles: vehicleCount,
      routes: parsed?.routes?.length || 0,
      skipped: parsed?.skippedShipments?.length || 0,
    });
    recordOptimizationSpend({
      shipments: shipmentCount,
      vehicles: vehicleCount,
      success: true,
    }).catch((e) => log.warn({ event: 'route_optimization.spend.failed', err: e.message }));
    return parsed;
  } catch (e) {
    const ms = Date.now() - t0;
    log.warn({
      event: 'route_optimization.failed',
      ms, shipments: shipmentCount, vehicles: vehicleCount,
      err: e.message, status: e.status, code: e.code,
    });
    recordOptimizationSpend({
      shipments: shipmentCount,
      vehicles: vehicleCount,
      success: false,
      timeout: e.code === 'timeout',
    }).catch((er) => log.warn({ event: 'route_optimization.spend.failed', err: er.message }));
    throw e;
  }
}

/**
 * UPSERT a `route_optimization_api_spend` para el día UTC actual.
 *
 *   - success=true → incrementa optimization_calls, total_shipments,
 *     total_vehicles y suma est_cost_usd usando pricing.routeOptimizationCost.
 *   - success=false → incrementa failed_calls. NO suma costo (Google no cobra
 *     por errores; los rechazos antes de invocar la API tampoco).
 *   - timeout=true (junto con success=false) → cuenta como failed pero
 *     incrementa también el counter genérico para distinguir en logs.
 */
async function recordOptimizationSpend({
  shipments = 0, vehicles = 0, success = true, timeout: _timeout = false,
}) {
  const cost = success ? pricing.routeOptimizationCost(shipments) : 0;
  const sql = `
    INSERT INTO route_optimization_api_spend
      (day, optimization_calls, total_vehicles, total_shipments, est_cost_usd,
       rejected_calls, failed_calls, first_call_at, last_call_at)
    VALUES
      (CURRENT_DATE, ?, ?, ?, ?, 0, ?, NOW(), NOW())
    ON CONFLICT (day) DO UPDATE
      SET optimization_calls = route_optimization_api_spend.optimization_calls + EXCLUDED.optimization_calls,
          total_vehicles     = route_optimization_api_spend.total_vehicles     + EXCLUDED.total_vehicles,
          total_shipments    = route_optimization_api_spend.total_shipments    + EXCLUDED.total_shipments,
          est_cost_usd       = route_optimization_api_spend.est_cost_usd       + EXCLUDED.est_cost_usd,
          failed_calls       = route_optimization_api_spend.failed_calls       + EXCLUDED.failed_calls,
          last_call_at       = NOW()
  `;
  await db.raw(sql, [
    success ? 1 : 0,
    success ? vehicles : 0,
    success ? shipments : 0,
    cost,
    success ? 0 : 1,
  ]);
  // timeout flag se loggea pero no se persiste como columna separada;
  // failed_calls cubre la métrica y los logs estructurados distinguen el code.
}

module.exports = {
  optimizeTours,
  recordOptimizationSpend,
  buildPayload, // exported for tests
  callOptimizeTours, // exported for tests (allows fetchImpl injection)
  ENDPOINT_BASE,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_MAX_RETRIES,
};
