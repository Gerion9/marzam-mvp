const reviewService = require('./review.service');

async function list(req, res, next) {
  try {
    const items = await reviewService.list(req.query);
    res.json(items);
  } catch (err) {
    next(err);
  }
}

async function resolve(req, res, next) {
  try {
    const { before, after } = await reviewService.resolve(req.params.id, {
      decision: req.body.decision,
      review_notes: req.body.review_notes,
      reviewed_by: req.user.id,
    });
    res.locals.auditDetail = { entityType: 'review_item', entityId: req.params.id, before, after };
    res.json(after);
  } catch (err) {
    next(err);
  }
}

async function batchResolve(req, res, next) {
  try {
    const result = await reviewService.batchResolve(req.body.ids, {
      decision: req.body.decision,
      review_notes: req.body.review_notes,
      reviewed_by: req.user.id,
    });
    res.locals.auditDetail = {
      entityType: 'review_item',
      entityId: req.body.ids,
      after: result.items,
    };
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function pendingCount(req, res, next) {
  try {
    const count = await reviewService.pendingCount();
    res.json({ pending: count });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, resolve, batchResolve, pendingCount };
