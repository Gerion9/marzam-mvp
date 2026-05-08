const service = require('./onboarding.service');
const spec = require('./onboarding.spec');

async function getSpec(_req, res) {
  res.json({
    docs_fisica: spec.DOCS_FISICA,
    docs_moral: spec.DOCS_MORAL,
    facade_found: spec.FACADE_FOUND,
    facade_not_found: spec.FACADE_NOT_FOUND,
    statuses: spec.STATUSES,
  });
}

async function create(req, res, next) {
  try {
    const row = await service.create({ userId: req.user.id, payload: req.body });
    res.status(201).json(row);
  } catch (err) { next(err); }
}

async function listMine(req, res, next) {
  try {
    const rows = await service.listMine({
      userId: req.user.id,
      limit: req.query.limit,
      status: req.query.status,
    });
    res.json(rows);
  } catch (err) { next(err); }
}

async function getOne(req, res, next) {
  try {
    const row = await service.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'No encontrado' });
    if (!req.user.is_global && row.created_by !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const docs = await service.listDocs(row.id);
    res.json({ ...row, documents: docs });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const row = await service.update({
      id: req.params.id,
      userId: req.user.id,
      isGlobal: req.user.is_global,
      patch: req.body || {},
    });
    res.json(row);
  } catch (err) { next(err); }
}

async function uploadDoc(req, res, next) {
  try {
    const lat = req.body.lat != null ? Number(req.body.lat) : null;
    const lng = req.body.lng != null ? Number(req.body.lng) : null;
    const doc = await service.uploadDoc({
      id: req.params.id,
      userId: req.user.id,
      isGlobal: req.user.is_global,
      docType: req.body.doc_type,
      file: req.file,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    });
    res.status(201).json(doc);
  } catch (err) { next(err); }
}

async function submit(req, res, next) {
  try {
    const result = await service.submit({
      id: req.params.id,
      userId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function creditDecision(req, res, next) {
  try {
    const row = await service.setCreditDecision({
      id: req.params.id,
      decision: req.body.decision,
      notes: req.body.notes,
      actorId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(row);
  } catch (err) { next(err); }
}

async function listProducts(req, res, next) {
  try {
    const row = await service.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'No encontrado' });
    if (!req.user.is_global && row.created_by !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const items = await service.listProducts(row.id);
    res.json(items);
  } catch (err) { next(err); }
}

async function addProduct(req, res, next) {
  try {
    const created = await service.addProduct({
      onboardingId: req.params.id,
      userId: req.user.id,
      isGlobal: req.user.is_global,
      payload: req.body || {},
    });
    res.status(201).json(created);
  } catch (err) { next(err); }
}

async function deleteProduct(req, res, next) {
  try {
    const result = await service.deleteProduct({
      onboardingId: req.params.id,
      productId: req.params.productId,
      userId: req.user.id,
      isGlobal: req.user.is_global,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function nearby(req, res, next) {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radius = Number(req.query.radius_m) || 250;
    const limit = Number(req.query.limit) || 20;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng inválidos' });
    }
    const rows = await service.nearbyNewCandidates({ lat, lng, radiusM: radius, limit });
    res.json(rows);
  } catch (err) { next(err); }
}

module.exports = {
  getSpec, create, listMine, getOne, update, uploadDoc, submit, creditDecision, nearby,
  listProducts, addProduct, deleteProduct,
};
