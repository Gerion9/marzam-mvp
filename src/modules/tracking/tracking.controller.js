const trackingService = require('./tracking.service');

async function recordPing(req, res, next) {
  try {
    const ping = await trackingService.recordPing({
      rep_id: req.user.id,
      rep_name: req.user.full_name,
      assignment_id: req.body.assignment_id,
      verification_id: req.body.verification_id,
      lat: req.body.lat,
      lng: req.body.lng,
      accuracy_meters: req.body.accuracy_meters,
    });
    res.status(201).json(ping);
  } catch (err) {
    next(err);
  }
}

async function recordPingBatch(req, res, next) {
  try {
    const pings = Array.isArray(req.body?.pings) ? req.body.pings : [];
    if (pings.length === 0) {
      return res.status(400).json({ error: 'pings array is required and must be non-empty' });
    }
    if (pings.length > 200) {
      return res.status(413).json({ error: 'Batch too large; max 200 pings per request' });
    }
    const result = await trackingService.recordPingBatch({
      rep_id: req.user.id,
      rep_name: req.user.full_name,
      pings,
    });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
}

async function checkin(req, res, next) {
  try {
    const result = await trackingService.checkin({
      rep_id: req.user.id,
      pharmacy_id: req.body.pharmacy_id,
      assignment_stop_id: req.body.assignment_stop_id,
      lat: req.body.lat,
      lng: req.body.lng,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

async function getCheckins(req, res, next) {
  try {
    const checkins = await trackingService.getCheckins(req.params.repId, {
      assignment_stop_id: req.query.assignment_stop_id,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });
    res.json(checkins);
  } catch (err) {
    next(err);
  }
}

async function getBreadcrumbs(req, res, next) {
  try {
    const pings = await trackingService.getBreadcrumbs(
      req.params.repId,
      req.query.assignment_id,
      { from: req.query.from, to: req.query.to },
    );
    res.json(pings);
  } catch (err) {
    next(err);
  }
}

async function getLatestPositions(_req, res, next) {
  try {
    const positions = await trackingService.getLatestPositions();
    res.json(positions);
  } catch (err) {
    next(err);
  }
}

module.exports = { recordPing, recordPingBatch, checkin, getCheckins, getBreadcrumbs, getLatestPositions };
