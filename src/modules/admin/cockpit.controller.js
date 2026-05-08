/**
 * Admin Cockpit controllers — thin handlers that translate query params into
 * service calls. All endpoints are admin-only (gate enforced in the router).
 *
 * Convention: try/catch + next(err). Returns degraded:true with empty shape
 * when the DB is unreachable so the cockpit UI can render skeletons rather
 * than crashing.
 */

const service = require('./cockpit.service');

const { isDbConnectionError } = service._internals;

function degraded(shape) {
  return { ...shape, degraded: true, generated_at: new Date().toISOString() };
}

async function hero(req, res, next) {
  try {
    const data = await service.hero({ compare: req.query.compare });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ deltas: {}, sparklines: {} }));
    next(err);
  }
}

async function trend(req, res, next) {
  try {
    const data = await service.trend({
      from: req.query.from,
      to: req.query.to,
      bucket: req.query.bucket,
    });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ series: {}, totals: {}, yoy: {} }));
    next(err);
  }
}

async function coverageHeatmap(req, res, next) {
  try {
    const data = await service.coverageHeatmap({
      level: req.query.level,
      days: Math.min(Number(req.query.days) || 30, 365),
    });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ features: [] }));
    next(err);
  }
}

async function hierarchy(req, res, next) {
  try {
    const data = await service.hierarchy({
      from: req.query.period_start || req.query.from,
      to: req.query.period_end || req.query.to,
    });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ roots: [] }));
    next(err);
  }
}

async function operations(req, res, next) {
  try {
    const data = await service.operations({ from: req.query.from, to: req.query.to });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({}));
    next(err);
  }
}

async function people(req, res, next) {
  try {
    const data = await service.people({
      from: req.query.from,
      to: req.query.to,
      role: req.query.role,
      branchId: req.query.branch_id,
    });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ ranking: [], compliance_heatmap: [] }));
    next(err);
  }
}

async function commercial(req, res, next) {
  try {
    const data = await service.commercial({ from: req.query.from, to: req.query.to });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ top_clients: [], funnel: {} }));
    next(err);
  }
}

async function onboarding(req, res, next) {
  try {
    const data = await service.onboarding({ from: req.query.from, to: req.query.to });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ funnel: [], pending_docs: [] }));
    next(err);
  }
}

async function dataQuality(req, res, next) {
  try {
    const data = await service.dataQuality();
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({}));
    next(err);
  }
}

async function system(req, res, next) {
  try {
    const data = await service.system();
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ cron_runs: [], routes_api: null }));
    next(err);
  }
}

async function auditFeed(req, res, next) {
  try {
    const data = await service.auditFeed({
      cursor: req.query.cursor,
      entityType: req.query.entity_type,
      action: req.query.action,
      userId: req.query.user_id,
      limit: req.query.limit,
    });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ items: [], next_cursor: null }));
    next(err);
  }
}

async function anomalies(req, res, next) {
  try {
    const data = await service.anomalies({ since: req.query.since });
    res.json(data);
  } catch (err) {
    if (isDbConnectionError(err)) return res.json(degraded({ items: [] }));
    next(err);
  }
}

module.exports = {
  hero,
  trend,
  coverageHeatmap,
  hierarchy,
  operations,
  people,
  commercial,
  onboarding,
  dataQuality,
  system,
  auditFeed,
  anomalies,
};
