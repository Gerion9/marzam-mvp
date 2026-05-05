const service = require('./estimation.service');

async function estimate(req, res, next) {
  try {
    const poblacion = req.query.poblacion || null;
    const branchId = req.query.branch_id || null;
    const result = await service.estimateCoverage({ poblacion, branchId });
    res.json(result);
  } catch (err) { next(err); }
}

async function estimateByPoblacion(req, res, next) {
  try {
    const branchId = req.query.branch_id || null;
    const result = await service.estimateByPoblacion({ branchId });
    res.json(result);
  } catch (err) { next(err); }
}

async function recommendations(req, res, next) {
  try {
    const poblacion = req.query.poblacion || null;
    const branchId = req.query.branch_id || null;
    const result = await service.recommendHeadcount({ poblacion, branchId });
    res.json(result);
  } catch (err) { next(err); }
}

module.exports = { estimate, estimateByPoblacion, recommendations };
