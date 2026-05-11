/**
 * Durable event bus for live operations (SSE) — Phase D rewrite.
 *
 * Producers call `publish(event)` to append to `live_event_outbox` (migration 065).
 * The trigger fires `pg_notify('live_events', <id>)` so every Node process
 * connected to the database — including future horizontally-scaled instances —
 * receives the new id, fetches the row, and fans out to its local SSE
 * subscribers.
 *
 * Subscribers call `subscribe({ userId, isGlobal, lastEventId }, onEvent)`.
 * On connect we replay any missed rows whose id > lastEventId; afterwards a
 * LISTEN'd connection pushes new events as they arrive.
 *
 * Outbox rows older than 24h are pruned by the daily purge cron.
 *
 * Backwards-compat: if migration 065 hasn't run, we degrade gracefully to the
 * old in-memory EventEmitter so dev environments keep working during rollout.
 */

const { EventEmitter } = require('events');
const teamScope = require('../../services/teamScope');
const db = require('../../config/database');

const bus = new EventEmitter();
bus.setMaxListeners(500);

const RECENT_BUFFER_MAX = 500;
const recent = []; // local cache for cheap replay

let outboxAvailable = null; // null = unknown, true/false after first probe
let listenerStarted = false;

// In-memory subscription counter — surfaced to BlackPrint usage-metrics so we
// can see how many SSE connections are alive on this Vercel instance. The
// counter is per-process; in a multi-instance Vercel deployment the BP
// dashboard sums what each instance reports if/when we add fan-in. For now
// it's a useful local indicator.
let activeSubscriptions = 0;
const liveStartedAt = new Date().toISOString();

async function probeOutbox() {
  try {
    await db.raw("SELECT to_regclass('live_event_outbox') AS t");
    const row = await db.raw("SELECT to_regclass('live_event_outbox') AS t");
    outboxAvailable = !!row.rows?.[0]?.t;
  } catch {
    outboxAvailable = false;
  }
  return outboxAvailable;
}

async function startPgListener() {
  if (listenerStarted) return;
  if (outboxAvailable === null) await probeOutbox();
  if (!outboxAvailable) return;
  // Get a dedicated connection from the pool and LISTEN. Knex doesn't expose
  // raw LISTEN cleanly, so we acquire via the pg client directly.
  try {
    const client = await db.client.pool.acquire().promise;
    await client.query('LISTEN live_events');
    client.on('notification', async (msg) => {
      const id = Number(msg.payload);
      if (!Number.isFinite(id)) return;
      try {
        const row = await db('live_event_outbox').where({ id }).first();
        if (!row) return;
        const ev = {
          id: row.id,
          ts: new Date(row.created_at).getTime(),
          type: row.event_type,
          subjectUserId: row.subject_user_id,
          audienceUserId: row.audience_user_id,
          payload: row.payload || {},
        };
        recent.push(ev);
        if (recent.length > RECENT_BUFFER_MAX) recent.shift();
        bus.emit('event', ev);
      } catch (err) {
        console.warn(`[live] notify fetch failed: ${err.message}`);
      }
    });
    listenerStarted = true;
  } catch (err) {
    // Fall back to in-memory bus for this process.
    console.warn(`[live] pg LISTEN unavailable, in-memory only: ${err.message}`);
    outboxAvailable = false;
  }
}

async function publish(event) {
  const enriched = { ...event, ts: event.ts || Date.now() };
  if (outboxAvailable === null) await probeOutbox();
  if (outboxAvailable) {
    try {
      // Insert into outbox; the trigger fires pg_notify.
      const [row] = await db('live_event_outbox').insert({
        event_type: enriched.type,
        subject_user_id: enriched.subjectUserId || null,
        audience_user_id: enriched.audienceUserId || null,
        payload: enriched.payload || {},
      }).returning('id');
      // Local emit too (so the listener in this process doesn't miss it
      // if the LISTEN hasn't started yet).
      enriched.id = typeof row === 'object' ? row.id : row;
      recent.push(enriched);
      if (recent.length > RECENT_BUFFER_MAX) recent.shift();
      bus.emit('event', enriched);
      return enriched;
    } catch (err) {
      console.warn(`[live] outbox insert failed, in-memory only: ${err.message}`);
      // fall through to in-memory
    }
  }
  recent.push(enriched);
  if (recent.length > RECENT_BUFFER_MAX) recent.shift();
  bus.emit('event', enriched);
  return enriched;
}

async function subscribe({ userId, isGlobal, lastEventId }, onEvent) {
  if (outboxAvailable === null) await probeOutbox();
  if (!listenerStarted) await startPgListener();

  let manageeIds = new Set();
  if (!isGlobal) {
    try {
      const descendants = await teamScope.getDescendants(userId);
      manageeIds = new Set([userId, ...descendants.map((d) => d.id)]);
    } catch {
      manageeIds = new Set([userId]);
    }
  }

  // Replay missed events.
  if (outboxAvailable && lastEventId) {
    try {
      const cutoff = Number(lastEventId);
      const rows = await db('live_event_outbox')
        .where('id', '>', cutoff)
        .orderBy('id', 'asc')
        .limit(2000);
      for (const row of rows) {
        const ev = {
          id: row.id,
          ts: new Date(row.created_at).getTime(),
          type: row.event_type,
          subjectUserId: row.subject_user_id,
          audienceUserId: row.audience_user_id,
          payload: row.payload || {},
        };
        if (allowed(ev, isGlobal, manageeIds, userId)) onEvent(ev);
      }
    } catch (err) {
      console.warn(`[live] outbox replay failed: ${err.message}`);
    }
  } else {
    // In-memory replay (degraded).
    const cutoff = lastEventId ? Number(lastEventId) : 0;
    for (const ev of recent) {
      if (ev.ts > cutoff && allowed(ev, isGlobal, manageeIds, userId)) onEvent(ev);
    }
  }

  const handler = (ev) => {
    if (allowed(ev, isGlobal, manageeIds, userId)) onEvent(ev);
  };
  bus.on('event', handler);
  activeSubscriptions += 1;
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    activeSubscriptions = Math.max(0, activeSubscriptions - 1);
    bus.off('event', handler);
  };
}

function getMetrics() {
  return {
    active_subscriptions: activeSubscriptions,
    recent_buffer_size: recent.length,
    recent_buffer_max: RECENT_BUFFER_MAX,
    outbox_available: outboxAvailable === true,
    listener_started: listenerStarted,
    started_at: liveStartedAt,
  };
}

function allowed(ev, isGlobal, manageeIds, userId) {
  if (isGlobal) return true;
  if (!ev.audienceUserId && !ev.subjectUserId) return true; // broadcast
  if (ev.audienceUserId && ev.audienceUserId === userId) return true;
  if (ev.subjectUserId && manageeIds.has(ev.subjectUserId)) return true;
  return false;
}

module.exports = {
  publish,
  subscribe,
  getMetrics,
};
