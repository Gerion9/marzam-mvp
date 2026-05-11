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

// Lock key estable para serializar settlements concurrentes del día. Usado
// adentro de recordOptimizationSpend para que `currentMonthlyVolume` no
// arrastre una lectura stale cuando dos llamadas terminan al mismo tiempo.
const SPEND_ADVISORY_LOCK_KEY = 0x720707; // 'r' 'o' 'o' (Route Opt Owner-ish) en ascii.

function utcMonthStartISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
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

  const payload = {
    parent: `projects/${getProjectId()}`,
    model: {
      vehicles: apiVehicles,
      shipments: apiShipments,
      durationDistanceMatrices: [apiMatrix],
    },
    searchMode: options.searchMode || 'CONSUME_ALL_AVAILABLE_TIME',
    timeout: durationToProto((options.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS)),
  };

  // Google's validate-only mode: parses the request, returns validation
  // errors if any, but does NOT execute the optimization heuristic. Critical:
  // shipments are NOT billed in this mode. We forward `validateOnly: true`
  // from the caller via options.solvingMode for CI/QA pipelines.
  if (options.validateOnly === true || options.solvingMode === 'VALIDATE_ONLY') {
    payload.solvingMode = 'VALIDATE_ONLY';
  }

  return payload;
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
    // solvingMode only present when caller set VALIDATE_ONLY — Google's
    // default is DEFAULT_SOLVE. Omitting keeps the payload smaller.
    ...(payload.solvingMode ? { solvingMode: payload.solvingMode } : {}),
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
  const kind = pricing.classifyOptimizationSku(vehicleCount);
  const isValidateOnly = payload.solvingMode === 'VALIDATE_ONLY';
  const t0 = Date.now();
  try {
    const { parsed } = await callOptimizeTours(payload, args.options);
    const ms = Date.now() - t0;
    // Google may flag shipments as infeasible — they are NOT billed by Google
    // and they should not bump our spend counters either. Subtract them so
    // total_shipments reflects what we actually paid for.
    const skipped = Array.isArray(parsed?.skippedShipments) ? parsed.skippedShipments.length : 0;
    const billableShipments = Math.max(0, shipmentCount - skipped);
    log.info({
      event: 'route_optimization.success',
      ms, shipments: shipmentCount, vehicles: vehicleCount, kind,
      validate_only: isValidateOnly,
      routes: parsed?.routes?.length || 0,
      skipped,
      billable_shipments: billableShipments,
    });
    recordOptimizationSpend({
      shipments: billableShipments,
      vehicles: vehicleCount,
      kind,
      success: true,
      validateOnly: isValidateOnly,
    }).catch((e) => log.warn({ event: 'route_optimization.spend.failed', err: e.message }));
    return parsed;
  } catch (e) {
    const ms = Date.now() - t0;
    log.warn({
      event: 'route_optimization.failed',
      ms, shipments: shipmentCount, vehicles: vehicleCount, kind,
      err: e.message, status: e.status, code: e.code,
    });
    // 5xx errors from Google are not billed; same for timeouts and
    // pre-flight 4xx rejections. We still log the failure for counters but
    // never sum cost on the failure path.
    recordOptimizationSpend({
      shipments: shipmentCount,
      vehicles: vehicleCount,
      kind,
      success: false,
      validateOnly: isValidateOnly,
    }).catch((er) => log.warn({ event: 'route_optimization.spend.failed', err: er.message }));
    throw e;
  }
}

/**
 * UPSERT al row del día UTC actual en `route_optimization_api_spend`.
 *
 * Semántica por flag:
 *   - validateOnly=true → solo bumpea validate_only_calls. Google NO factura
 *     este modo, no tocamos cost ni los counters por-SKU.
 *   - success=true → incrementa per-SKU shipments/calls según `kind`
 *     ('single'|'fleet'), incrementa los agregados (optimization_calls,
 *     total_*) y suma el costo INCREMENTAL piecewise computando contra el
 *     volumen mensual ya consumido en ese SKU. La lectura+escritura corren
 *     bajo un advisory lock para que dos settlements concurrentes vean el
 *     mismo "before" y no doblecuenten la transición de tier.
 *   - success=false → incrementa failed_calls. NO toca costo ni shipments
 *     (Google no factura errores 5xx / timeouts / 4xx pre-flight).
 *
 * Los infeasible shipments del response ya fueron descartados arriba en
 * optimizeTours, así que `shipments` aquí solo cuenta los facturables.
 */
async function recordOptimizationSpend({
  shipments = 0, vehicles = 0, kind = 'single',
  success = true, validateOnly = false,
}) {
  if (validateOnly) {
    await db.raw(`
      INSERT INTO route_optimization_api_spend
        (day, validate_only_calls, first_call_at, last_call_at)
      VALUES (CURRENT_DATE, 1, NOW(), NOW())
      ON CONFLICT (day) DO UPDATE
        SET validate_only_calls = route_optimization_api_spend.validate_only_calls + 1,
            last_call_at = NOW()
    `);
    return;
  }

  const isFleet = kind === 'fleet';

  // Spend settlement under advisory lock — reads the month-to-date shipment
  // count for this SKU before computing the incremental piecewise cost. This
  // makes tier-boundary settlement deterministic under concurrency: two
  // 4_998-and-4_999 → 5_001 settlements both read the same "before" value.
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [SPEND_ADVISORY_LOCK_KEY]);

    let monthlySoFar = 0;
    if (success && shipments > 0) {
      const row = await trx('route_optimization_api_spend')
        .where('day', '>=', utcMonthStartISO())
        .sum({
          single: 'single_vehicle_shipments',
          fleet: 'fleet_routing_shipments',
        })
        .first();
      monthlySoFar = Number((isFleet ? row?.fleet : row?.single) || 0);
    }

    const cost = success
      ? pricing.routeOptimizationIncrementalCost({
        shipments, currentMonthlyVolume: monthlySoFar, kind: isFleet ? 'fleet' : 'single',
      })
      : 0;

    await trx.raw(`
      INSERT INTO route_optimization_api_spend
        (day, optimization_calls, total_vehicles, total_shipments,
         single_vehicle_calls, single_vehicle_shipments,
         fleet_routing_calls, fleet_routing_shipments,
         est_cost_usd, failed_calls, first_call_at, last_call_at)
      VALUES (CURRENT_DATE, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON CONFLICT (day) DO UPDATE
        SET optimization_calls       = route_optimization_api_spend.optimization_calls       + EXCLUDED.optimization_calls,
            total_vehicles           = route_optimization_api_spend.total_vehicles           + EXCLUDED.total_vehicles,
            total_shipments          = route_optimization_api_spend.total_shipments          + EXCLUDED.total_shipments,
            single_vehicle_calls     = route_optimization_api_spend.single_vehicle_calls     + EXCLUDED.single_vehicle_calls,
            single_vehicle_shipments = route_optimization_api_spend.single_vehicle_shipments + EXCLUDED.single_vehicle_shipments,
            fleet_routing_calls      = route_optimization_api_spend.fleet_routing_calls      + EXCLUDED.fleet_routing_calls,
            fleet_routing_shipments  = route_optimization_api_spend.fleet_routing_shipments  + EXCLUDED.fleet_routing_shipments,
            est_cost_usd             = route_optimization_api_spend.est_cost_usd             + EXCLUDED.est_cost_usd,
            failed_calls             = route_optimization_api_spend.failed_calls             + EXCLUDED.failed_calls,
            last_call_at             = NOW()
    `, [
      success ? 1 : 0,
      success ? vehicles : 0,
      success ? shipments : 0,
      (success && !isFleet) ? 1 : 0,
      (success && !isFleet) ? shipments : 0,
      (success && isFleet) ? 1 : 0,
      (success && isFleet) ? shipments : 0,
      cost,
      success ? 0 : 1,
    ]);
  });
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
