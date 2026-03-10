const auditService = require('./audit.service');

async function list(req, res, next) {
  try {
    const events = await auditService.list(req.query);
    res.json(events);
  } catch (err) {
    next(err);
  }
}

async function getByEntity(req, res, next) {
  try {
    const events = await auditService.getByEntity(req.params.entityType, req.params.entityId);
    res.json(events);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getByEntity };
