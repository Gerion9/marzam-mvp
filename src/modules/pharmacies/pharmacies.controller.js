const pharmacyService = require('./pharmacies.service');

async function list(req, res, next) {
  try {
    const filters = { ...req.query };
    if (req.user.role === 'field_rep') {
      filters.rep_id = req.user.id;
      filters.restrict_to_assigned = true;
    }
    const pharmacies = await pharmacyService.list(filters);
    res.json(pharmacies);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    if (req.user.role === 'field_rep') {
      const assigned = await pharmacyService.isAssignedToRep(req.params.id, req.user.id);
      if (!assigned) {
        return res.status(403).json({ error: 'You are not assigned to this pharmacy' });
      }
    }
    const pharmacy = await pharmacyService.getById(req.params.id);
    res.json(pharmacy);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const { before, after } = await pharmacyService.update(req.params.id, req.body, req.user.id);
    res.locals.auditDetail = { entityType: 'pharmacy', entityId: req.params.id, before, after };
    res.json(after);
  } catch (err) {
    next(err);
  }
}

async function createCandidate(req, res, next) {
  try {
    const pharmacy = await pharmacyService.createCandidate({
      ...req.body,
      created_by: req.user.id,
    });
    res.status(201).json(pharmacy);
  } catch (err) {
    next(err);
  }
}

async function findInsidePolygon(req, res, next) {
  try {
    const pharmacies = await pharmacyService.findInsidePolygon(req.body.polygon);
    res.json(pharmacies);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getById, update, createCandidate, findInsidePolygon };
