const trackingService = require('./tracking.service');

async function recordPing(req, res, next) {
  try {
    const ping = await trackingService.recordPing({
      rep_id: req.user.id,
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

async function getLatestPositions(req, res, next) {
  try {
    const positions = await trackingService.getLatestPositions();
    res.json(positions);
  } catch (err) {
    next(err);
  }
}

module.exports = { recordPing, checkin, getCheckins, getBreadcrumbs, getLatestPositions };
