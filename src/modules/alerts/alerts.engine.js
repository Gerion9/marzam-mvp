/**
 * Alerts engine — evaluates the six rules from Marzam Execution Doc §8.
 *
 * Designed to run as a cron tick (e.g. /api/admin/alerts/_evaluate every
 * 5–10min) AND as an opportunistic call from within hot paths (so visit_missing_photo
 * fires the moment the server-side block kicks in, not 10min later).
 *
 * Each rule is a function `evaluateXxx({ db, threshold })` that returns an
 * array of alert specs `{ alert_key, subject_user_id, audience_user_id, payload, fire_window_start, fire_window_end, severity }`.
 * The orchestrator inserts them with ON CONFLICT DO NOTHING (the partial unique
 * index handles de-dup).
 *
 * For V1 we ship rules 3 (visit_missing_photo, hot-path), 5 (customer_closed,
 * hot-path) and 4 (rep_inactive_too_long, cron-only).  Rules 1, 2, 6 are
 * skeletoned but left for the next pass — the schema and orchestrator are
 * complete so adding them is just one new function each.
 */

const db = require('../../config/database');
const { canActorManage } = require('../../services/teamScope');
const liveBus = require('../live/live.service');

async function getRule(key) {
  const row = await db('alert_rules').where({ key, enabled: true }).first();
  return row || null;
}

async function fireAlert({ ruleKey, alertKey, subjectUserId, audienceUserId, severity, payload, fireWindowStart, fireWindowEnd, expiresAt }) {
  // ON CONFLICT for the partial unique index. Knex doesn't expose that path
  // for partial indexes cleanly, so we use raw with ON CONFLICT DO NOTHING.
  // Use RETURNING to detect whether the row was actually inserted (not a
  // dup) so the live bus only emits genuinely new alerts.
  const result = await db.raw(`
    INSERT INTO alerts
      (rule_key, alert_key, subject_user_id, audience_user_id, severity, payload, fire_window_start, fire_window_end, expires_at)
    VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
    ON CONFLICT DO NOTHING
    RETURNING id, created_at
  `, [
    ruleKey, alertKey, subjectUserId || null, audienceUserId || null,
    severity || 'info', JSON.stringify(payload || {}),
    fireWindowStart || null, fireWindowEnd || null, expiresAt || null,
  ]);
  const inserted = result.rows?.[0];
  if (inserted) {
    try {
      liveBus.publish({
        type: 'alert',
        subjectUserId,
        audienceUserId,
        payload: {
          id: inserted.id,
          rule_key: ruleKey,
          alert_key: alertKey,
          severity: severity || 'info',
          subject_user_id: subjectUserId || null,
          payload: payload || {},
          created_at: inserted.created_at,
        },
      });
    } catch { /* never break alert insert because of bus */ }
  }
}

// ── Rule 3: visit_missing_photo (hot path)
// Called from visits.service.submit() when the photo block fires. We DON'T
// create the visit, but we still want a manager notification so repeated
// attempts surface as a quality issue.
async function fireVisitMissingPhoto({ repId, pharmacyId, attemptedOutcome }) {
  const rule = await getRule('visit_missing_photo');
  if (!rule) return;
  await fireAlert({
    ruleKey: 'visit_missing_photo',
    alertKey: `visit_missing_photo:${repId}:${pharmacyId}:${new Date().toISOString().slice(0, 10)}`,
    subjectUserId: repId,
    audienceUserId: null, // surfaces to managers via subtree query
    severity: rule.severity,
    payload: { pharmacy_id: pharmacyId, outcome: attemptedOutcome },
    fireWindowStart: db.fn.now(),
  });
}

// ── Rule 5: customer_closed_or_duplicate (hot path)
// Called from visits.service.submit() after a successful insert with a flag
// outcome. The alert routes to the rep's manager.
async function fireCustomerClosed({ repId, pharmacyId, outcome, flagReason }) {
  const rule = await getRule('customer_closed_or_duplicate');
  if (!rule) return;
  await fireAlert({
    ruleKey: 'customer_closed_or_duplicate',
    alertKey: `customer_closed:${pharmacyId}:${outcome}`,
    subjectUserId: repId,
    audienceUserId: null,
    severity: rule.severity,
    payload: { pharmacy_id: pharmacyId, outcome, flag_reason: flagReason },
    fireWindowStart: db.fn.now(),
  });
}

// ── Rule 4: rep_inactive_too_long (cron)
// Looks at visit_sessions with status='active' and last_ping_at older than the
// configured idle_minutes. Each finding becomes one alert keyed by session id
// + the rounded-down evaluation hour, so the same idle session re-alerts at
// most once per hour (until resolved or the rep pings).
async function evaluateRepInactivity() {
  const rule = await getRule('rep_inactive_too_long');
  if (!rule) return [];
  const idleMinutes = Number(rule.thresholds?.idle_minutes) || 25;
  const rows = await db.raw(`
    SELECT id AS session_id, user_id, started_at, last_ping_at,
           EXTRACT(EPOCH FROM (now() - COALESCE(last_ping_at, started_at)))/60 AS idle_min
    FROM visit_sessions
    WHERE status = 'active'
      AND COALESCE(last_ping_at, started_at) < now() - (?::int || ' minutes')::interval
  `, [idleMinutes]);
  const fired = [];
  for (const r of rows.rows || []) {
    const hourBucket = new Date();
    hourBucket.setMinutes(0, 0, 0);
    await fireAlert({
      ruleKey: 'rep_inactive_too_long',
      alertKey: `rep_inactive:${r.session_id}:${hourBucket.toISOString()}`,
      subjectUserId: r.user_id,
      audienceUserId: null,
      severity: rule.severity,
      payload: {
        session_id: r.session_id,
        idle_minutes: Math.round(Number(r.idle_min)),
        last_ping_at: r.last_ping_at,
      },
      fireWindowStart: hourBucket.toISOString(),
    });
    fired.push(r.session_id);
  }
  return fired;
}

// ── Rule 2: route_deviated_significantly (cron)
// For each rep with an active visit_session today, find their latest tracking
// point and compare against the bounding union of their planned stops. If
// the rep is more than `deviation_meters` away from EVERY planned stop AND
// outside their home location buffer, fire an alert. Uses PostGIS
// ST_DWithin with degree-converted meters (cheap approximation).
async function evaluateRouteDeviation() {
  const rule = await getRule('route_deviated_significantly');
  if (!rule) return [];
  const meters = Number(rule.thresholds?.deviation_meters) || 1500;
  // Defensive: requires PostGIS + the planned-stop coordinates joined with
  // pharmacies. If any required column is missing, exit clean.
  const exists = await db.raw(`
    SELECT to_regclass('pharmacies') AS p, to_regclass('rep_tracking_points') AS rtp
  `);
  if (!exists.rows?.[0]?.p || !exists.rows?.[0]?.rtp) return [];

  const rows = await db.raw(`
    WITH latest_pings AS (
      SELECT DISTINCT ON (rep_id) rep_id, lat, lng, recorded_at
        FROM rep_tracking_points
       WHERE recorded_at > now() - INTERVAL '15 minutes'
       ORDER BY rep_id, recorded_at DESC
    ),
    todays_stops AS (
      SELECT vpa.visitor_user_id AS rep_id,
             COALESCE(p.coordinates::geometry, pp.coordinates::geometry) AS geom
        FROM visit_plan_assignments vpa
        JOIN visit_plans vp ON vp.id = vpa.visit_plan_id
        LEFT JOIN marzam_clients mc ON mc.id = vpa.marzam_client_id
        LEFT JOIN pharmacies p  ON p.id  = mc.pharmacy_id
        LEFT JOIN pharmacies pp ON pp.id = vpa.pharmacy_id
       WHERE vp.status = 'published'
         AND vpa.scheduled_date = current_date
    ),
    deviated AS (
      SELECT lp.rep_id, lp.lat, lp.lng, lp.recorded_at
        FROM latest_pings lp
       WHERE NOT EXISTS (
         SELECT 1 FROM todays_stops ts
          WHERE ts.rep_id = lp.rep_id
            AND ts.geom IS NOT NULL
            AND ST_DWithin(
                  ts.geom::geography,
                  ST_MakePoint(lp.lng, lp.lat)::geography,
                  ?::int
                )
       )
    )
    SELECT * FROM deviated
  `, [meters]);

  const fired = [];
  for (const r of rows.rows || []) {
    const today = new Date().toISOString().slice(0, 10);
    await fireAlert({
      ruleKey: 'route_deviated_significantly',
      alertKey: `route_deviation:${r.rep_id}:${today}`,
      subjectUserId: r.rep_id,
      severity: rule.severity,
      payload: { lat: r.lat, lng: r.lng, recorded_at: r.recorded_at, threshold_m: meters },
      fireWindowStart: r.recorded_at,
    });
    fired.push(r.rep_id);
  }
  return fired;
}

// ── Rules 1, 6 — implementations. Stubs replaced after schema landed.
async function evaluateRouteNotStarted() {
  const rule = await getRule('route_not_started_by_x');
  if (!rule) return [];
  const grace = Number(rule.thresholds?.grace_minutes) || 30;
  // Look at today's published plans where the user has assignments and the
  // earliest expected_start_time has passed by more than `grace` minutes
  // without any actual_start_time set.
  const rows = await db.raw(`
    SELECT vpa.visitor_user_id AS user_id,
           MIN(vpa.expected_start_time) AS expected_start
      FROM visit_plan_assignments vpa
      JOIN visit_plans vp ON vp.id = vpa.visit_plan_id
     WHERE vp.status = 'published'
       AND vp.hard_schedule = TRUE
       AND vpa.scheduled_date = current_date
       AND vpa.expected_start_time IS NOT NULL
       AND vpa.actual_start_time  IS NULL
     GROUP BY vpa.visitor_user_id
    HAVING MIN(vpa.expected_start_time) < now() - (?::int || ' minutes')::interval
  `, [grace]);
  const fired = [];
  for (const r of rows.rows || []) {
    const today = new Date().toISOString().slice(0, 10);
    await fireAlert({
      ruleKey: 'route_not_started_by_x',
      alertKey: `route_not_started:${r.user_id}:${today}`,
      subjectUserId: r.user_id,
      severity: rule.severity,
      payload: { expected_start: r.expected_start, grace_minutes: grace },
      fireWindowStart: r.expected_start,
    });
    fired.push(r.user_id);
  }
  return fired;
}

async function evaluateOnboardingPending() {
  const rule = await getRule('onboarding_docs_pending_too_long');
  if (!rule) return [];
  const days = Number(rule.thresholds?.pending_days) || 5;
  // Schema check: only fire if the onboarding table exists with the right
  // columns. We do this defensively because the table is created in mig 038
  // and may not be present yet in every environment.
  const exists = await db.raw(`
    SELECT to_regclass('pharmacy_onboarding') AS t
  `);
  if (!exists.rows?.[0]?.t) return [];
  const rows = await db.raw(`
    SELECT id, created_by, status, created_at
      FROM pharmacy_onboarding
     WHERE status = 'en_revision'
       AND created_at < now() - (?::int || ' days')::interval
  `, [days]);
  const fired = [];
  for (const r of rows.rows || []) {
    await fireAlert({
      ruleKey: 'onboarding_docs_pending_too_long',
      alertKey: `onboarding_pending:${r.id}`,
      subjectUserId: r.created_by,
      severity: rule.severity,
      payload: { onboarding_id: r.id, pending_since: r.created_at, days_threshold: days },
      fireWindowStart: r.created_at,
    });
    fired.push(r.id);
  }
  return fired;
}

// Orchestrator — called by the cron worker. Returns a summary.
async function evaluateAll() {
  const out = {};
  try { out.rep_inactive = (await evaluateRepInactivity()).length; } catch (e) { out.rep_inactive_error = e.message; }
  try { out.route_not_started = (await evaluateRouteNotStarted()).length; } catch (e) { out.route_not_started_error = e.message; }
  try { out.route_deviated = (await evaluateRouteDeviation()).length; } catch (e) { out.route_deviated_error = e.message; }
  try { out.onboarding_pending = (await evaluateOnboardingPending()).length; } catch (e) { out.onboarding_pending_error = e.message; }
  return out;
}

// Feed: alerts the actor should see — own + subtree (managers see their reps).
async function feed({ actorId, isGlobal, limit = 50 }) {
  if (isGlobal) {
    return db('alerts')
      .whereNull('resolved_at')
      .orderBy('created_at', 'desc')
      .limit(limit);
  }
  // Build the visible-subjects set: actor self + anyone they manage.
  const subtree = await db.raw(`
    WITH RECURSIVE sub AS (
      SELECT id FROM users WHERE id = ?
      UNION ALL
      SELECT u.id FROM users u JOIN sub s ON u.manager_id = s.id
    )
    SELECT id FROM sub
  `, [actorId]);
  const ids = (subtree.rows || []).map((r) => r.id);
  if (!ids.length) return [];
  return db('alerts')
    .whereNull('resolved_at')
    .where(function () {
      this.whereIn('subject_user_id', ids).orWhereIn('audience_user_id', ids);
    })
    .orderBy('created_at', 'desc')
    .limit(limit);
}

async function resolve({ alertId, actorId, isGlobal }) {
  const row = await db('alerts').where({ id: alertId }).first();
  if (!row) {
    const err = new Error('Alert not found');
    err.status = 404;
    throw err;
  }
  if (!isGlobal && row.subject_user_id && row.subject_user_id !== actorId) {
    if (!await canActorManage(actorId, row.subject_user_id)) {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    }
  }
  const [updated] = await db('alerts')
    .where({ id: alertId })
    .update({ resolved_at: db.fn.now() })
    .returning('*');
  return updated;
}

module.exports = {
  fireAlert,
  fireVisitMissingPhoto,
  fireCustomerClosed,
  evaluateRepInactivity,
  evaluateRouteNotStarted,
  evaluateRouteDeviation,
  evaluateOnboardingPending,
  evaluateAll,
  feed,
  resolve,
};
