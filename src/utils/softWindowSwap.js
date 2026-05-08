/**
 * Audit Fix #6 — soft-window-aware post-pass.
 *
 * `multiStart.solve` chooses a sequence that minimizes pairwise driving cost.
 * It does NOT consider per-stop opening hours (`opening_hours_v2`); see the
 * structural test `tests/routing/softWindowWiring.test.js`. Wiring soft
 * windows into `buildCostFn` directly is a multi-week project (the cost
 * needs to know cumulative arrival time, which a pairwise costFn cannot
 * compute without state — and changing solver behavior universally requires
 * an A/B benchmark against published plans).
 *
 * This module is the conservative alternative: run AFTER multiStart picks
 * a route, do a swap-improve pass that simulates each adjacent-pair swap,
 * computes the resulting arrival times, and accepts the swap only if:
 *   1. Total soft-window slip strictly DECREASES, AND
 *   2. Total drive time INCREASES by at most `maxCostIncreaseRatio` (default 5%).
 *
 * The result is a tour that respects opening hours where doing so is cheap
 * and ignores them where it would cause a major detour. Predictable,
 * bounded, no architecture changes to the solver.
 *
 * Feature-flagged by `PLAN_SOFT_WINDOW_AWARE` (default false). Off → no-op.
 */

const DEFAULT_MAX_COST_INCREASE_RATIO = 0.05;
const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_MAX_SWAPS_PER_ITER = 4;

/**
 * Compute total drive time + soft-window slip for a route, given:
 *   - depot at index 0 of the cost matrix
 *   - stops in the order specified
 *   - costMatrix[i][j] = duration_seconds from i to j (depot is index 0)
 *   - serviceMinutesFor(stop) → minutes spent at the stop (caller-provided)
 *   - softWindowSlipSecondsFor(stop, arrivalDate) → equivalent-seconds penalty
 *   - dayStart: JS Date in UTC representing the start time of the day
 *
 * Returns { driveSeconds, slipSeconds, arrivals: Date[] } where arrivals[i]
 * is the arrival time at stop[i].
 */
function evaluateRoute({
  stopsWithSeqIdx, costMatrix, dayStart,
  serviceMinutesFor, softWindowSlipSecondsFor,
}) {
  let cursor = new Date(dayStart);
  let prevSeq = 0;
  let driveSeconds = 0;
  let slipSeconds = 0;
  const arrivals = [];
  for (const stop of stopsWithSeqIdx) {
    const segS = costMatrix[prevSeq]?.[stop.__seqIdx];
    const segSeconds = Number.isFinite(segS) ? segS : 0;
    driveSeconds += segSeconds;
    cursor = new Date(cursor.getTime() + segSeconds * 1000);
    const arrival = new Date(cursor);
    arrivals.push(arrival);
    slipSeconds += softWindowSlipSecondsFor(stop, arrival) || 0;
    cursor = new Date(cursor.getTime() + (serviceMinutesFor(stop) || 0) * 60 * 1000);
    prevSeq = stop.__seqIdx;
  }
  return { driveSeconds, slipSeconds, arrivals };
}

/**
 * Apply a single adjacent swap (positions i, i+1) and return a NEW array.
 */
function swapAdjacent(arr, i) {
  const out = arr.slice();
  [out[i], out[i + 1]] = [out[i + 1], out[i]];
  return out;
}

/**
 * Try every adjacent swap; accept the BEST one that reduces slip without
 * blowing the cost-increase ratio. Returns { ordered, accepted } where
 * `accepted` is the number of swaps applied across all iterations.
 *
 * Idempotent under the same inputs — deterministic.
 */
function improveForSoftWindows({
  ordered,
  costMatrix,
  dayStart,
  serviceMinutesFor,
  softWindowSlipSecondsFor,
  maxCostIncreaseRatio = DEFAULT_MAX_COST_INCREASE_RATIO,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  maxSwapsPerIter = DEFAULT_MAX_SWAPS_PER_ITER,
}) {
  if (!Array.isArray(ordered) || ordered.length < 2) {
    return { ordered: ordered || [], accepted: 0, baseSlipSeconds: 0, finalSlipSeconds: 0 };
  }

  let cur = ordered.slice();
  const baseEval = evaluateRoute({
    stopsWithSeqIdx: cur, costMatrix, dayStart,
    serviceMinutesFor, softWindowSlipSecondsFor,
  });

  const baseSlipSeconds = baseEval.slipSeconds;
  const baseDriveSeconds = baseEval.driveSeconds;
  let totalAccepted = 0;
  let bestSlip = baseSlipSeconds;
  let bestDrive = baseDriveSeconds;

  for (let iter = 0; iter < maxIterations; iter += 1) {
    let acceptedThisIter = 0;

    for (let i = 0; i < cur.length - 1 && acceptedThisIter < maxSwapsPerIter; i += 1) {
      const candidate = swapAdjacent(cur, i);
      const cand = evaluateRoute({
        stopsWithSeqIdx: candidate, costMatrix, dayStart,
        serviceMinutesFor, softWindowSlipSecondsFor,
      });
      // Acceptance criteria:
      //   1. slip strictly decreases (>= 1 second improvement to avoid jitter)
      //   2. drive time within base * (1 + ratio)
      if (cand.slipSeconds + 1 > bestSlip) continue;
      const driveCap = baseDriveSeconds * (1 + maxCostIncreaseRatio);
      if (cand.driveSeconds > driveCap) continue;

      // Accept.
      cur = candidate;
      bestSlip = cand.slipSeconds;
      bestDrive = cand.driveSeconds;
      acceptedThisIter += 1;
      totalAccepted += 1;
    }

    if (acceptedThisIter === 0) break;
  }

  return {
    ordered: cur,
    accepted: totalAccepted,
    baseSlipSeconds,
    finalSlipSeconds: bestSlip,
    baseDriveSeconds,
    finalDriveSeconds: bestDrive,
  };
}

module.exports = {
  improveForSoftWindows,
  evaluateRoute,
  // exposed for tests
  _swapAdjacent: swapAdjacent,
  DEFAULT_MAX_COST_INCREASE_RATIO,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_SWAPS_PER_ITER,
};
