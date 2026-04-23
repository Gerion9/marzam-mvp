const territoriesRepository = require('../../repositories/territoriesRepository');
const { canAccessTerritory } = require('../permissions/permissions');
const { isExternalDataMode } = require('../../repositories/runtime');

async function listTree(user) {
  if (isExternalDataMode()) return [];
  const all = await territoriesRepository.listAll();
  if (user && (user.is_global || user.role === 'national_admin' || user.role === 'manager')) {
    return buildTree(all);
  }
  const allowed = new Set(user?.accessible_territory_ids || []);
  const filtered = all.filter((t) => allowed.has(t.id));
  return buildTree(filtered);
}

function buildTree(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

async function listFlat() {
  if (isExternalDataMode()) return [];
  return territoriesRepository.listAll();
}

async function getById(id) {
  if (isExternalDataMode()) return null;
  return territoriesRepository.getById(id);
}

async function listUsers(territoryId) {
  if (isExternalDataMode()) return [];
  return territoriesRepository.listUsersInTerritory(territoryId);
}

function externalModeWriteError() {
  const err = new Error('Territory management is not available in external data mode');
  err.status = 501;
  return err;
}

async function assignUser({ territoryId, userId, roleInTerritory, assignedBy }) {
  if (isExternalDataMode()) throw externalModeWriteError();
  return territoriesRepository.assignUserToTerritory({
    userId,
    territoryId,
    roleInTerritory,
    assignedBy,
  });
}

async function revokeUser({ territoryId, userId }) {
  if (isExternalDataMode()) throw externalModeWriteError();
  return territoriesRepository.revokeUserFromTerritory({ userId, territoryId });
}

async function create({ parentId, level, name, code, metadata, actor }) {
  if (isExternalDataMode()) throw externalModeWriteError();
  if (parentId && actor && !actor.is_global) {
    if (!canAccessTerritory(actor, parentId)) {
      const err = new Error('Cannot create territory outside your scope');
      err.status = 403;
      throw err;
    }
  }
  return territoriesRepository.create({ parentId, level, name, code, metadata });
}

async function update(id, patch, actor) {
  if (isExternalDataMode()) throw externalModeWriteError();
  if (actor && !actor.is_global && !canAccessTerritory(actor, id)) {
    const err = new Error('Cannot modify territory outside your scope');
    err.status = 403;
    throw err;
  }
  return territoriesRepository.update(id, patch);
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
