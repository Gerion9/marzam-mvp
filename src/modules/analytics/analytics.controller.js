const service = require('./analytics.service');

async function team(req, res, next) {
  try {
    const result = await service.complianceHeatmap({
      actor: req.user,
      scopeUserId: req.query.user_id || null,
      dateFrom: req.query.from,
      dateTo: req.query.to,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function paretoMix(req, res, next) {
  try {
    const rows = await service.paretoMix({
      actor: req.user,
      scopeUserId: req.query.user_id || null,
      dateFrom: req.query.from,
      dateTo: req.query.to,
    });
    res.json(rows);
  } catch (err) { next(err); }
}

async function untouched(req, res, next) {
  try {
    const days = Number(req.query.days_without) || 30;
    const limit = Math.min(Number(req.query.limit) || 25, 200);
    const rows = await service.untouchedClients({ actor: req.user, daysWithout: days, limit });
    res.json(rows);
  } catch (err) { next(err); }
}

module.exports = { team, paretoMix, untouched };
