const verificationService = require('./verifications.service');
const pharmacyService = require('../pharmacies/pharmacies.service');

async function listByPharmacy(req, res, next) {
  try {
    if (req.user.role === 'field_rep') {
      const assigned = await pharmacyService.isAssignedToRep(req.params.pharmacyId, req.user.id);
      if (!assigned) {
        return res.status(403).json({ error: 'You are not assigned to this pharmacy' });
      }
    }

    const rows = await verificationService.listByPharmacy(req.params.pharmacyId);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function listEvidence(req, res, next) {
  try {
    const filters = { ...req.query };
    if (req.user.role === 'field_rep') {
      filters.rep_id = req.user.id;
    }
    const rows = await verificationService.listEvidence(filters);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getRepSummary(req, res, next) {
  try {
    const repId = req.user.role === 'field_rep' ? req.user.id : req.params.repId;
    const summary = await verificationService.getRepSummary(repId);
    res.json(summary);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listByPharmacy,
  listEvidence,
  getRepSummary,
};
