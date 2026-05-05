/**
 * In-memory event bus for live operations (SSE).
 *
 * Producers (tracking pings, alerts engine, assignment status changes) call
 * `publish(event)` to push events. Consumers (manager dashboards via SSE)
 * call `subscribe({ audienceUserId, isGlobal })` to register an EventEmitter
 * listener that the SSE handler streams to the browser.
 *
 * Single-process: this works for one Node instance. If horizontally scaled,
 * swap this in-memory bus for Redis pub/sub (the public API stays the same).
 *
 * Event shape:
 *   { type: 'position'|'alert'|'assignment_status', payload: {...}, ts: ms,
 *     subjectUserId?, audienceUserId? }
 *
 * Filtering: each subscriber receives events whose `audienceUserId` is
 *   - null/undefined (broadcast)
 *   - equal to the subscriber's userId
 *   - in the subscriber's manageeIds set (so a manager sees their reps' events)
 * is_global subscribers receive everything.
 */

const { EventEmitter } = require('events');
const teamScope = require('../../services/teamScope');

const bus = new EventEmitter();
bus.setMaxListeners(200);

const RECENT_BUFFER_MAX = 500;
const recent = []; // last N events for replay-on-reconnect

function publish(event) {
  const enriched = { ...event, ts: event.ts || Date.now() };
  recent.push(enriched);
  if (recent.length > RECENT_BUFFER_MAX) recent.shift();
  bus.emit('event', enriched);
  return enriched;
}

async function subscribe({ userId, isGlobal, lastEventId }, onEvent) {
  // Resolve managee set once at subscribe-time. Live updates to the team
  // hierarchy during a live session are rare; reps don't switch managers
  // mid-day. We accept slight staleness.
  let manageeIds = new Set();
  if (!isGlobal) {
    try {
      const descendants = await teamScope.getDescendants(userId);
      manageeIds = new Set([userId, ...descendants.map((d) => d.id)]);
    } catch {
      manageeIds = new Set([userId]);
    }
  }

  // Replay buffered events newer than lastEventId (timestamp ms).
  const cutoff = lastEventId ? Number(lastEventId) : 0;
  for (const ev of recent) {
    if (ev.ts > cutoff && allowed(ev, isGlobal, manageeIds, userId)) onEvent(ev);
  }

  const handler = (ev) => {
    if (allowed(ev, isGlobal, manageeIds, userId)) onEvent(ev);
  };
  bus.on('event', handler);
  return () => bus.off('event', handler);
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
};
