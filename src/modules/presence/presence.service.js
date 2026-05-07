/**
 * presence.service — daily reconciliation of `rep_tracking_points` against
 * `pharmacies` to populate `pharmacy_presence`.
 *
 * Invoked by the `reconcile-presence` cron (admin.routes.js, schedule
 * "30 8 * * *" — runs before the 9:00 tracking purge so all of yesterday's
 * pings are still alive).
 *
 * Algorithm (single SQL with CTEs):
 *   1) `candidates` — JOIN rep_tracking_points × pharmacies via ST_DWithin
 *      with the configured radius for the day's pings.
 *   2) `sessioned` — for each (rep, pharmacy), a new "session" starts whenever
 *      consecutive pings are more than MAX_GAP_SECONDS apart.
 *   3) `qualifying` — sum dwell across sessions per (rep, pharmacy), keep
 *      only those with at least one session ≥ MIN_DWELL_SECONDS.
 *   4) UPSERT into `pharmacy_presence` (rep_id, pharmacy_id, presence_date).
 *
 * Then a second statement updates `has_visit_report` and `visit_id` from
 * `visit_reports` of the same (rep, pharmacy, day).
 *
 * Idempotent: the UPSERT replaces the prior row for the same (rep, pharmacy,
 * day). Configurable knobs are env-driven so tuning doesn't need a deploy.
 */

const db = require('../../config/database');
const { emitWarning } = require('../bq-sync/warnings');

const PRESENCE_RADIUS_M = Number(process.env.PRESENCE_RADIUS_M) || 100;
const MIN_DWELL_SECONDS = Number(process.env.PRESENCE_MIN_DWELL_SECONDS) || 300;
const MAX_GAP_SECONDS = Number(process.env.PRESENCE_MAX_GAP_SECONDS) || 600;
const PRESENCE_TZ = process.env.PRESENCE_TZ || 'America/Mexico_City';
const JOB_NAME = 'reconcile-presence';

function yesterdayInTz(tz) {
  // Yesterday's calendar date in the target timezone, formatted YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const todayStr = fmt.format(new Date());
  const today = new Date(`${todayStr}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

function isValidIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

async function reconcileDay({ date, force = false } = {}) {
  const targetDate = isValidIsoDate(date) ? date : yesterdayInTz(PRESENCE_TZ);
  const startedAt = Date.now();

  // Skip if rows already exist for this day, unless force=true.
  if (!force) {
    const [{ cnt } = { cnt: 0 }] = await db('pharmacy_presence')
      .where('presence_date', targetDate)
      .count({ cnt: '*' });
    if (Number(cnt) > 0) {
      return {
        date: targetDate,
        skipped: 'already_computed',
        existing_rows: Number(cnt),
        runtime_ms: Date.now() - startedAt,
      };
    }
  }

  // Defensive: if there are no pings in the day window, surface a warning
  // (likely a Vercel Cron / time-zone misconfiguration) and exit cleanly.
  const pingProbe = await db.raw(`
    SELECT COUNT(*)::int AS n
      FROM rep_tracking_points
     WHERE recorded_at >= (?::date::timestamp AT TIME ZONE ?)
       AND recorded_at <  ((?::date + INTERVAL '1 day')::timestamp AT TIME ZONE ?)
  `, [targetDate, PRESENCE_TZ, targetDate, PRESENCE_TZ]);
  const pingCount = Number(pingProbe.rows?.[0]?.n || 0);
  if (pingCount === 0) {
    await emitWarning(db, {
      jobName: JOB_NAME,
      code: 'presence.no_pings',
      subject: targetDate,
      detail: { date: targetDate, tz: PRESENCE_TZ },
    });
    return {
      date: targetDate,
      reps_processed: 0,
      presence_rows_upserted: 0,
      with_visit_report: 0,
      without_visit_report: 0,
      ping_count: 0,
      runtime_ms: Date.now() - startedAt,
      warning: 'no_pings',
    };
  }

  // Surface pharmacies appearing as candidates that lack coordinates — they
  // can't anchor a geofence so they should be triaged separately.
  await flagPharmaciesWithoutGeo();

  // Single insert/upsert from the full CTE pipeline.
  const upsertResult = await db.raw(buildReconcileSql(), [
    targetDate, PRESENCE_TZ,
    targetDate, PRESENCE_TZ,
    PRESENCE_RADIUS_M,
    MAX_GAP_SECONDS,
    MIN_DWELL_SECONDS,
    targetDate,
  ]);
  const upserted = upsertResult.rowCount || 0;

  // Cross-reference with visit_reports for the same day.
  const linkResult = await db.raw(`
    UPDATE pharmacy_presence pp
       SET has_visit_report = true,
           visit_id         = vr.id
      FROM visit_reports vr
     WHERE pp.presence_date = ?::date
       AND vr.rep_id        = pp.rep_id
       AND vr.pharmacy_id   = pp.pharmacy_id
       AND vr.created_at::date = pp.presence_date
  `, [targetDate]);
  const withReport = linkResult.rowCount || 0;

  const repsRow = await db.raw(`
    SELECT COUNT(DISTINCT rep_id)::int AS n
      FROM pharmacy_presence
     WHERE presence_date = ?::date
  `, [targetDate]);
  const repsProcessed = Number(repsRow.rows?.[0]?.n || 0);

  return {
    date: targetDate,
    reps_processed: repsProcessed,
    presence_rows_upserted: upserted,
    with_visit_report: withReport,
    without_visit_report: Math.max(upserted - withReport, 0),
    ping_count: pingCount,
    runtime_ms: Date.now() - startedAt,
    config: {
      radius_m: PRESENCE_RADIUS_M,
      min_dwell_seconds: MIN_DWELL_SECONDS,
      max_gap_seconds: MAX_GAP_SECONDS,
      tz: PRESENCE_TZ,
    },
  };
}

async function flagPharmaciesWithoutGeo() {
  // Best-effort: each missing-geo pharmacy in scope today gets a warning.
  // We cap to 50 to avoid runaway noise.
  try {
    const rows = await db('pharmacies')
      .select('id', 'name')
      .whereNull('coordinates')
      .where(function () { this.where('is_independent', true).orWhere('source', 'marzam'); })
      .limit(50);
    for (const row of rows) {
      await emitWarning(db, {
        jobName: JOB_NAME,
        code: 'presence.pharmacy_no_geo',
        subject: row.id,
        detail: { name: row.name },
      });
    }
  } catch {
    // Never break the cron because of a defensive probe.
  }
}

// Returns the SQL string for the main reconcile pipeline. Externalized so
// tests can lock the shape without spinning up a DB.
function buildReconcileSql() {
  // Note: the literal `> 500` in the distance_warning expression mirrors
  // DISTANCE_WARNING_THRESHOLD_M from src/utils/geoDistance.js. If you change
  // one, change the other.
  return `
    WITH params AS (
      SELECT
        ?::date    AS d,
        ?::text    AS tz
    ),
    day_window AS (
      SELECT
        d,
        (?::date::timestamp AT TIME ZONE ?::text)                       AS day_start,
        ((?::date + INTERVAL '1 day')::timestamp AT TIME ZONE ?::text)  AS day_end,
        ?::int                                                            AS radius_m,
        ?::int                                                            AS max_gap_s,
        ?::int                                                            AS min_dwell_s
      FROM params
    ),
    candidates AS (
      SELECT
        rtp.rep_id,
        rtp.recorded_at,
        p.id AS pharmacy_id,
        ST_Distance(rtp.point, p.coordinates) AS distance_m
      FROM rep_tracking_points rtp
      JOIN day_window dw
        ON rtp.recorded_at >= dw.day_start AND rtp.recorded_at < dw.day_end
      JOIN pharmacies p
        ON p.coordinates IS NOT NULL
       AND ST_DWithin(rtp.point, p.coordinates, (SELECT radius_m FROM day_window))
    ),
    laggy AS (
      SELECT
        c.*,
        LAG(recorded_at) OVER (PARTITION BY rep_id, pharmacy_id ORDER BY recorded_at) AS prev_at
      FROM candidates c
    ),
    sessioned AS (
      SELECT
        l.*,
        SUM(
          CASE
            WHEN prev_at IS NULL THEN 1
            WHEN EXTRACT(EPOCH FROM (recorded_at - prev_at)) > (SELECT max_gap_s FROM day_window) THEN 1
            ELSE 0
          END
        ) OVER (PARTITION BY rep_id, pharmacy_id ORDER BY recorded_at) AS session_id
      FROM laggy l
    ),
    sessions AS (
      SELECT
        rep_id, pharmacy_id, session_id,
        MIN(recorded_at)        AS first_seen_at,
        MAX(recorded_at)        AS last_seen_at,
        COUNT(*)::int           AS ping_count,
        MAX(distance_m)         AS max_distance_m,
        MIN(distance_m)         AS min_distance_m,
        EXTRACT(EPOCH FROM (MAX(recorded_at) - MIN(recorded_at)))::int AS dwell_seconds
      FROM sessioned
      GROUP BY rep_id, pharmacy_id, session_id
    ),
    qualifying AS (
      SELECT
        rep_id,
        pharmacy_id,
        SUM(dwell_seconds)::int   AS dwell_seconds,
        MIN(first_seen_at)        AS first_seen_at,
        MAX(last_seen_at)         AS last_seen_at,
        SUM(ping_count)::int      AS ping_count,
        MAX(max_distance_m)       AS max_distance_m,
        MIN(min_distance_m)       AS min_distance_m
      FROM sessions
      WHERE dwell_seconds >= (SELECT min_dwell_s FROM day_window)
      GROUP BY rep_id, pharmacy_id
    )
    INSERT INTO pharmacy_presence (
      rep_id, pharmacy_id, presence_date, dwell_seconds,
      max_distance_m, min_distance_m, first_seen_at, last_seen_at, ping_count,
      distance_warning, computed_at
    )
    SELECT
      rep_id, pharmacy_id, ?::date, dwell_seconds,
      ROUND(max_distance_m::numeric, 2),
      ROUND(min_distance_m::numeric, 2),
      first_seen_at, last_seen_at, ping_count,
      (min_distance_m > 500),
      now()
    FROM qualifying
    ON CONFLICT (rep_id, pharmacy_id, presence_date)
    DO UPDATE SET
      dwell_seconds    = EXCLUDED.dwell_seconds,
      max_distance_m   = EXCLUDED.max_distance_m,
      min_distance_m   = EXCLUDED.min_distance_m,
      first_seen_at    = EXCLUDED.first_seen_at,
      last_seen_at     = EXCLUDED.last_seen_at,
      ping_count       = EXCLUDED.ping_count,
      distance_warning = EXCLUDED.distance_warning,
      computed_at      = now()
  `;
}

module.exports = {
  reconcileDay,
  // Exposed for tests; not part of the public API.
  _internals: {
    buildReconcileSql,
    yesterdayInTz,
    isValidIsoDate,
    JOB_NAME,
    PRESENCE_RADIUS_M,
    MIN_DWELL_SECONDS,
    MAX_GAP_SECONDS,
    PRESENCE_TZ,
  },
};
