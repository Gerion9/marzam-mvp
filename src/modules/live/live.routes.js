/**
 * Live operations endpoints.
 *
 * /api/live/stream     — Server-Sent Events. Streams positions, alerts, and
 *                        assignment status changes filtered by the caller's
 *                        managee scope.
 * /api/live/eta-quick  — Sub-200ms response with driving ETA from a current
 *                        GPS position to a planned stop. Used by My Route to
 *                        update the "next stop" card every 60s.
 */

const { Router } = require('express');
const authenticate = require('../../middleware/auth');
const liveService = require('./live.service');
const routesMatrix = require('../../services/routesMatrix');
const db = require('../../config/database');

const router = Router();

router.get('/stream', authenticate, async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/proxy buffering
    res.flushHeaders?.();

    // Initial heartbeat so the browser confirms the open connection.
    res.write(`: connected ${Date.now()}\n\n`);

    const lastEventId = req.headers['last-event-id'] || req.query.last_event_id;
    const send = (event) => {
      try {
        res.write(`id: ${event.ts}\n`);
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event.payload || {})}\n\n`);
      } catch {
        // socket closed mid-write — cleanup happens on close event
      }
    };

    const unsubscribe = await liveService.subscribe({
      userId: req.user.id,
      isGlobal: req.user.is_global,
      lastEventId,
    }, send);

    // 30s heartbeat to keep proxies from cutting the idle connection.
    const heartbeat = setInterval(() => {
      try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* closed */ }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      try { unsubscribe(); } catch { /* noop */ }
      try { res.end(); } catch { /* noop */ }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/eta-quick', authenticate, async (req, res, next) => {
  try {
    const { from, to_assignment, to_lat, to_lng } = req.query;
    if (!from) return res.status(400).json({ error: 'from=lat,lng required' });
    const [fLat, fLng] = String(from).split(',').map(Number);
    if (!Number.isFinite(fLat) || !Number.isFinite(fLng)) {
      return res.status(400).json({ error: 'from must be "lat,lng"' });
    }
    let toLat = Number(to_lat);
    let toLng = Number(to_lng);
    if (to_assignment) {
      // Resolve the assignment's pharmacy coordinates.
      const row = await db('visit_plan_assignments as vpa')
        .leftJoin('marzam_clients as mc', 'mc.id', 'vpa.marzam_client_id')
        .leftJoin('pharmacies as p', 'p.id', 'mc.pharmacy_id')
        .leftJoin('pharmacies as pp', 'pp.id', 'vpa.pharmacy_id')
        .select(
          db.raw('COALESCE(ST_X(p.coordinates::geometry), ST_X(pp.coordinates::geometry)) AS lng'),
          db.raw('COALESCE(ST_Y(p.coordinates::geometry), ST_Y(pp.coordinates::geometry)) AS lat'),
        )
        .where('vpa.id', to_assignment)
        .first();
      if (!row || row.lat == null) return res.status(404).json({ error: 'assignment has no coordinates' });
      toLat = Number(row.lat);
      toLng = Number(row.lng);
    }
    if (!Number.isFinite(toLat) || !Number.isFinite(toLng)) {
      return res.status(400).json({ error: 'to_assignment or to_lat/to_lng required' });
    }
    // Use cached matrix to keep this cheap. Single pair → small call.
    const result = await routesMatrix.computeMatrixCached(
      [{ lat: fLat, lng: fLng }],
      [{ lat: toLat, lng: toLng }],
      { preference: 'TRAFFIC_AWARE', departureTime: new Date() },
    );
    const r = result[0];
    res.json({
      duration_seconds: r?.durationSeconds || 0,
      distance_meters: r?.distanceMeters || 0,
      eta_minutes: Math.round((r?.durationSeconds || 0) / 60),
      flag: r?.flag || 'unknown',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
