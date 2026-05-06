/**
 * Timezone helpers — Marzam operates in America/Mexico_City (UTC-6 standard).
 *
 * The planGenerator and alerts engine were both treating "08:00" as UTC, which
 * meant `expected_arrival_time = 02:00 CDMX` and the route_not_started alert
 * fired at 02:30 AM local instead of 08:30. This module is the single source of
 * truth for converting (local-iso-day, HH:MM) into a correct UTC `Date`.
 *
 * We rely on `Intl.DateTimeFormat` with the `timeZone` option, which Node 22
 * (and every modern browser) supports natively — no luxon dependency.
 */

const TIMEZONE = 'America/Mexico_City';

/**
 * Get the UTC offset of the given Date in CDMX (in minutes).
 * Mexico abolished DST in 2022 nationally, but Sonora and the northern border
 * cities still observe US-style DST. For Marzam we use the centro/sur offset
 * which is fixed at UTC-6 year-round.
 *
 * The Intl-based computation is robust to future DST policy changes in case
 * the country re-introduces it.
 */
function offsetMinutes(date) {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
  return Math.round((local.getTime() - utc.getTime()) / 60000);
}

/**
 * Convert a local-day ISO string + HH:MM into a UTC Date.
 *
 * Example: localDayHHMMToUTC('2026-05-04', '08:00') in CDMX (UTC-6) returns a
 * Date whose .toISOString() is '2026-05-04T14:00:00.000Z'.
 *
 * Used by planGenerator.parseHHMMToDate and any caller that writes
 * `expected_arrival_time` / `expected_start_time` into a TIMESTAMPTZ column.
 */
function localDayHHMMToUTC(isoDay, hhmm) {
  const [h, m] = (hhmm || '08:00').split(':').map(Number);
  // Step 1: pretend the hh:mm is UTC to seed a Date object.
  const seed = new Date(`${isoDay}T${pad(h)}:${pad(m)}:00.000Z`);
  // Step 2: ask what offset CDMX has at that wall-clock instant. For dates
  // before 2022-10-30 (last DST end) Mexico did observe DST; we honor whatever
  // the runtime says.
  const off = offsetMinutes(seed); // minutes east of UTC; CDMX = -360
  // Step 3: shift the seed by the negative of the offset to get the real UTC.
  return new Date(seed.getTime() - off * 60_000);
}

/**
 * Convert a UTC Date back into 'YYYY-MM-DD' as it would appear on a CDMX wall
 * clock. Useful for grouping by "scheduled date" in a way that matches the rep
 * experience (a 23:30 CDMX visit belongs to that day, not the next UTC day).
 */
function utcToLocalIsoDay(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date); // en-CA gives YYYY-MM-DD
}

/**
 * Format a UTC Date as 'HH:MM' in CDMX wall-clock.
 */
function utcToLocalHHMM(date) {
  const fmt = new Intl.DateTimeFormat('es-MX', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return fmt.format(date);
}

function pad(n) { return String(n).padStart(2, '0'); }

module.exports = {
  TIMEZONE,
  localDayHHMMToUTC,
  utcToLocalIsoDay,
  utcToLocalHHMM,
  offsetMinutes,
};
