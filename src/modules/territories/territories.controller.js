const territoriesService = require('./territories.service');

async function listTree(req, res, next) {
  try {
    const tree = await territoriesService.listTree(req.user);
    res.json(tree);
  } catch (err) {
    next(err);
  }
}

async function listFlat(req, res, next) {
  try {
    const rows = await territoriesService.listFlat();
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const row = await territoriesService.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Territory not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
}

async function listUsers(req, res, next) {
  try {
    const rows = await territoriesService.listUsers(req.params.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function assignUser(req, res, next) {
  try {
    const row = await territoriesService.assignUser({
      territoryId: req.params.id,
      userId: req.body.user_id,
      roleInTerritory: req.body.role_in_territory || null,
      assignedBy: req.user.id,
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

async function revokeUser(req, res, next) {
  try {
    await territoriesService.revokeUser({
      territoryId: req.params.id,
      userId: req.params.userId,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const row = await territoriesService.create({
      parentId: req.body.parent_id || null,
      level: req.body.level,
      name: req.body.name,
      code: req.body.code || null,
      metadata: req.body.metadata || {},
      actor: req.user,
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const row = await territoriesService.update(req.params.id, req.body, req.user);
    res.json(row);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listTree,
  listFlat,
  getById,
  listUsers,
  assignUser,
  revokeUser,
  create,
  update,
};
