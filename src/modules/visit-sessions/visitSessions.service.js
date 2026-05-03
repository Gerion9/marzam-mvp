const db = require('../../config/database');
const { canActorManage } = require('../../services/teamScope');

const ABANDON_AFTER_MINUTES = 120;

async function getActiveForUser(userId) {
  return db('visit_sessions')
    .where({ user_id: userId, status: 'active' })
    .orderBy('started_at', 'desc')
    .first();
}

async function start({ userId, branchId, visitPlanId, pharmaciesPlanned, notes }) {
  // Cerrar abandonadas previas (cualquier sesión activa con last_ping > umbral).
  await db('visit_sessions')
    .where({ user_id: userId, status: 'active' })
    .andWhere(function () {
      this.whereNull('last_ping_at')
        .orWhereRaw(`last_ping_at < now() - interval '${ABANDON_AFTER_MINUTES} minutes'`);
    })
    .update({ status: 'abandoned', ended_at: db.fn.now(), ended_reason: 'idle_timeout' });

  const existing = await getActiveForUser(userId);
  if (existing) return existing;

  const [row] = await db('visit_sessions')
    .insert({
      user_id: userId,
      branch_id: branchId || null,
      visit_plan_id: visitPlanId || null,
      pharmacies_planned: pharmaciesPlanned || 0,
      notes: notes || null,
      last_ping_at: db.fn.now(),
    })
    .returning('*');
  return row;
}

async function end({ sessionId, userId, isGlobal, reason = 'manual' }) {
  const session = await db('visit_sessions').where({ id: sessionId }).first();
  if (!session) {
    const err = new Error('Session not found');
    err.status = 404;
    throw err;
  }
  if (!isGlobal && session.user_id !== userId && !await canActorManage(userId, session.user_id)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  if (session.status !== 'active') return session;

  // Calcular distancia total agregando rep_tracking_points entre started_at y now (best-effort)
  let totalDistanceM = session.total_distance_m;
  if (totalDistanceM == null) {
    try {
      const distRow = await db.raw(`
        SELECT COALESCE(SUM(
          ST_DistanceSphere(
            ST_MakePoint(p1.lng, p1.lat),
            ST_MakePoint(p2.lng, p2.lat)
          )
        ), 0)::int AS distance_m
        FROM rep_tracking_points p1
        JOIN rep_tracking_points p2
          ON p2.rep_id = p1.rep_id
         AND p2.recorded_at = (
           SELECT MIN(recorded_at) FROM rep_tracking_points
            WHERE rep_id = p1.rep_id AND recorded_at > p1.recorded_at
         )
        WHERE p1.rep_id = ?
          AND p1.recorded_at >= ?::timestamptz
      `, [session.user_id, session.started_at]);
      totalDistanceM = Number(distRow.rows?.[0]?.distance_m) || 0;
    } catch {
      totalDistanceM = 0;
    }
  }

  const [row] = await db('visit_sessions')
    .where({ id: sessionId })
    .update({
      ended_at: db.fn.now(),
      status: 'ended',
      ended_reason: reason,
      total_distance_m: totalDistanceM,
    })
    .returning('*');
  return row;
}

async function recordPing(sessionId) {
  if (!sessionId) return null;
  await db('visit_sessions')
    .where({ id: sessionId, status: 'active' })
    .update({ last_ping_at: db.fn.now() });
}

async function recordVisit(sessionId) {
  if (!sessionId) return null;
  await db('visit_sessions')
    .where({ id: sessionId, status: 'active' })
    .increment('pharmacies_visited', 1)
    .update({ last_ping_at: db.fn.now() });
}

async function listForUser({ userId, actorId, isGlobal, limit = 30 }) {
  if (!isGlobal && userId !== actorId && !await canActorManage(actorId, userId)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return db('visit_sessions')
    .where({ user_id: userId })
    .orderBy('started_at', 'desc')
    .limit(Number(limit) || 30);
}

async function getActive({ targetUserId, actorId, isGlobal }) {
  if (!isGlobal && targetUserId !== actorId && !await canActorManage(actorId, targetUserId)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return getActiveForUser(targetUserId);
}

module.exports = {
  start,
  end,
  recordPing,
  recordVisit,
  listForUser,
  getActive,
  getActiveForUser,
};
