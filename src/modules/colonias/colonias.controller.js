const coloniasService = require('./colonias.service');

async function list(req, res, next) {
  try {
    const filters = { ...req.query };
    if (filters.bbox) {
      filters.bbox = String(filters.bbox).split(',').map(Number);
    }
    const colonias = await coloniasService.list(filters);
    res.json(colonias);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const colonia = await coloniasService.getById(req.params.id);
    res.json(colonia);
  } catch (err) {
    next(err);
  }
}

async function geojson(req, res, next) {
  try {
    const filters = { ...req.query };
    if (filters.bbox) {
      filters.bbox = String(filters.bbox).split(',').map(Number);
    }
    const fc = await coloniasService.listAsGeoJSON(filters);
    res.json(fc);
  } catch (err) {
    next(err);
  }
}

async function updateSecurityLevel(req, res, next) {
  try {
    const { before, after } = await coloniasService.updateSecurityLevel(req.params.id, {
      security_level: req.body.security_level,
      updated_by: req.user.id,
    });
    res.locals.auditDetail = { entityType: 'colonia', entityId: req.params.id, before, after };
    res.json(after);
  } catch (err) {
    next(err);
  }
}

async function batchUpdateSecurityLevel(req, res, next) {
  try {
    const result = await coloniasService.batchUpdateSecurityLevel(req.body.ids, {
      security_level: req.body.security_level,
      updated_by: req.user.id,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getById, geojson, updateSecurityLevel, batchUpdateSecurityLevel };
