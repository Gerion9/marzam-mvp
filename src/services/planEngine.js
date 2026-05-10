/**
 * planEngine — pure date/window math for the plan generator.
 *
 * Encapsulates the rules:
 *   - working days are configurable per branch (default Dom-Vie, sábado siempre
 *     inhábil per Marzam ops).
 *   - cutoff time decides whether a "daily" plan owns today or shifts to mañana
 *     laboral. Same idea for weekly/monthly: candidateStart is bumped past the
 *     cutoff.
 *   - monthly plans respect the calendar month — no spill into next month.
 *   - custom plans honor the requested range but filter out non-working days.
 *
 * All calculations are done in the branch timezone. Inputs that look like UTC
 * Dates are converted via `utcToLocalIsoDay`/`utcToLocalHHMM` from utils/timezone.
 *
 * This module is pure (no DB, no I/O). Tests live in tests/services/planEngine.test.js.
 */

const { utcToLocalIsoDay, utcToLocalHHMM, localDayHHMMToUTC } = require('../utils/timezone');

function dateFromIso(iso) {
  // 'YYYY-MM-DD' → Date at UTC midnight, but we only ever inspect getUTC* fields,
  // so the timezone never moves the day index.
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function dayOfWeek(iso) {
  return dateFromIso(iso).getUTCDay(); // 0=Sun..6=Sat
}

function addDays(iso, n) {
  const d = dateFromIso(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(iso) {
  const d = dateFromIso(iso);
  // First day of next month, then back 1 day.
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

/** True if the ISO day is a working day under the given workingDays array. */
function isWorkingDay(iso, workingDays) {
  return workingDays.includes(dayOfWeek(iso));
}

/** Next working day strictly after `iso`. */
function nextWorkingDay(iso, workingDays) {
  let cur = addDays(iso, 1);
  // Safety bound: ~14 iters max even with the most restrictive working_days.
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(cur, workingDays)) return cur;
    cur = addDays(cur, 1);
  }
  throw new Error('nextWorkingDay: no working day in 14-day window');
}

/** `iso` itself if it's a working day; otherwise the next one. */
function bumpToWorkingDay(iso, workingDays) {
  if (isWorkingDay(iso, workingDays)) return iso;
  return nextWorkingDay(iso, workingDays);
}

/** Last working day on or before the end of the calendar month of `iso`. */
function lastWorkingDayOfMonth(iso, workingDays) {
  let cur = lastDayOfMonth(iso);
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(cur, workingDays)) return cur;
    cur = addDays(cur, -1);
  }
  throw new Error('lastWorkingDayOfMonth: no working day in last 14 days of month');
}

/**
 * End of the work-week containing `iso`. "Week" = the Mon..Sun ISO week. The end
 * is the last working day of that week. Default workingDays=[0..5] means the
 * end-of-week is Friday (5); if a branch ever flips Saturday on (6), this still
 * returns the latest working day of the week.
 */
function endOfWorkWeek(iso, workingDays) {
  // ISO-week starts Monday. We want the Friday (or whatever the last working
  // day of [Mon..Sat] is). Sunday is treated as the start of the next work-week
  // in Marzam ops (Dom-Vie means Sunday belongs to the upcoming Mon-Fri block).
  const dow = dayOfWeek(iso); // 0=Sun..6=Sat
  // Distance forward to reach Saturday (6).
  const toSat = (6 - dow + 7) % 7; // 0..6
  const sat = addDays(iso, toSat);
  // Walk back from Saturday to the last workingDay <= Saturday.
  let cur = sat;
  for (let i = 0; i < 7; i++) {
    if (isWorkingDay(cur, workingDays)) return cur;
    cur = addDays(cur, -1);
  }
  throw new Error('endOfWorkWeek: no working day found');
}

/** Every working day between `start` and `end` (inclusive). */
function eachWorkingDay(start, end, workingDays) {
  const out = [];
  let cur = start;
  for (let safety = 0; safety < 366; safety++) {
    if (cur > end) break;
    if (isWorkingDay(cur, workingDays)) out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Resolve the plan window given the requested type and current time.
 *
 * @param {Object} args
 * @param {Date}   args.now              UTC `Date` (defaults to new Date())
 * @param {string} args.planType         'daily' | 'weekly' | 'monthly' | 'custom'
 * @param {string} [args.customStart]    'YYYY-MM-DD' (required for custom)
 * @param {string} [args.customEnd]      'YYYY-MM-DD' (required for custom)
 * @param {Object} args.branchSettings   from branchPlanSettings.get()
 *
 * @returns {{ period_start: string, period_end: string, working_dates: string[],
 *             cutoff_at: string, working_days_snapshot: number[],
 *             before_cutoff: boolean }}
 */
function resolveWindow({ now, planType, customStart, customEnd, branchSettings }) {
  if (!branchSettings) throw new Error('branchSettings required');
  const { cutoff_hhmm, working_days } = branchSettings;
  const refDate = now instanceof Date ? now : new Date();

  const todayIso = utcToLocalIsoDay(refDate);
  // Intl.DateTimeFormat with es-MX returns '24:00' at exact midnight instead
  // of '00:00'. Normalize so string-compare against cutoff works.
  const rawHHMM = utcToLocalHHMM(refDate);
  const nowHHMM = rawHHMM === '24:00' ? '00:00' : rawHHMM;
  const beforeCutoff = nowHHMM < cutoff_hhmm;

  // candidateStart honors the cutoff: before → today (or bump to working),
  // after → next working day.
  let candidateStart;
  if (beforeCutoff) {
    candidateStart = bumpToWorkingDay(todayIso, working_days);
  } else {
    candidateStart = nextWorkingDay(todayIso, working_days);
  }

  let periodStart;
  let periodEnd;

  switch (planType) {
    case 'daily':
      periodStart = candidateStart;
      periodEnd = candidateStart;
      break;

    case 'weekly':
      periodStart = candidateStart;
      periodEnd = endOfWorkWeek(candidateStart, working_days);
      // Edge case: if cutoff bumped us into next week, endOfWorkWeek of
      // candidateStart is still that next week — correct.
      if (periodEnd < periodStart) periodEnd = periodStart;
      break;

    case 'monthly':
      periodStart = candidateStart;
      periodEnd = lastWorkingDayOfMonth(candidateStart, working_days);
      break;

    case 'custom':
      if (!customStart || !customEnd) {
        throw new Error('custom plan requires customStart and customEnd (YYYY-MM-DD)');
      }
      if (customEnd < customStart) {
        throw new Error('custom plan: customEnd must be >= customStart');
      }
      // Bump start/end to the nearest working day boundary so the window only
      // contains working days. We do NOT shift the calendar range itself —
      // we just trim the edges if they fall on non-working days.
      periodStart = bumpToWorkingDay(customStart, working_days);
      periodEnd = isWorkingDay(customEnd, working_days)
        ? customEnd
        : (() => {
            let c = customEnd;
            for (let i = 0; i < 7; i++) {
              if (isWorkingDay(c, working_days)) return c;
              c = addDays(c, -1);
              if (c < periodStart) return periodStart;
            }
            return periodStart;
          })();
      break;

    default:
      throw new Error(`Unknown planType: ${planType}`);
  }

  const working_dates = eachWorkingDay(periodStart, periodEnd, working_days);

  return {
    period_start: periodStart,
    period_end: periodEnd,
    working_dates,
    cutoff_at: refDate.toISOString(),
    working_days_snapshot: [...working_days],
    before_cutoff: beforeCutoff,
  };
}

module.exports = {
  resolveWindow,
  isWorkingDay,
  nextWorkingDay,
  bumpToWorkingDay,
  eachWorkingDay,
  endOfWorkWeek,
  lastWorkingDayOfMonth,
  dayOfWeek,
  addDays,
  // re-exported for callers that need to roundtrip dates
  utcToLocalIsoDay,
  utcToLocalHHMM,
  localDayHHMMToUTC,
};
