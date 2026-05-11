/**
 * BlackPrint controllers — thin error-handling wrappers around the service.
 *
 * Pattern mirrors src/modules/admin/cockpit.controller.js: each handler tries
 * the service call and degrades gracefully (returns an empty-shape payload
 * with `_degraded: true` and the reason) when the underlying tables don't
 * exist yet or DB is unreachable. The BP dashboard renders the empty shape
 * cleanly instead of breaking on missing data.
 */

const service = require('./blackprint.service');

function degraded(reason) {
  return { _degraded: true, _reason: reason, generated_at: new Date().toISOString() };
}

async function costSummary(req, res, next) {
  try {
    const out = await service.costSummary();
    res.json(out);
  } catch (err) {
    if (/relation .* does not exist|table .* not found/i.test(err.message)) {
      return res.json(degraded(err.message));
    }
    next(err);
  }
}

async function geocodingQuality(req, res, next) {
  try {
    const out = await service.geocodingQuality();
    res.json(out);
  } catch (err) {
    if (/relation .* does not exist/i.test(err.message)) {
      return res.json(degraded(err.message));
    }
    next(err);
  }
}

async function systemHealth(req, res, next) {
  try {
    const out = await service.systemHealth();
    res.json(out);
  } catch (err) {
    if (/relation .* does not exist/i.test(err.message)) {
      return res.json(degraded(err.message));
    }
    next(err);
  }
}

async function usageMetrics(req, res, next) {
  try {
    const out = await service.usageMetrics();
    res.json(out);
  } catch (err) {
    if (/relation .* does not exist/i.test(err.message)) {
      return res.json(degraded(err.message));
    }
    next(err);
  }
}

function directory(req, res, next) {
  try {
    const out = service.directory();
    res.json(out);
  } catch (err) { next(err); }
}

module.exports = { costSummary, geocodingQuality, systemHealth, usageMetrics, directory };
