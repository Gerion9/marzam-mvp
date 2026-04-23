const db = require('../config/database');

async function getById(id) {
  if (!id) return null;
  return db('territories').where({ id }).first();
}

async function getByCode(code) {
  if (!code) return null;
  return db('territories').where({ code }).first();
}

async function listAll({ activeOnly = true } = {}) {
  const q = db('territories').select('*').orderBy(['level', 'name']);
  if (activeOnly) q.where({ is_active: true });
  return q;
}

async function listChildren(parentId) {
  return db('territories')
    .where({ parent_id: parentId, is_active: true })
    .orderBy('name');
}

async function listDescendants(rootId) {
  if (!rootId) return [];
  const rows = await db.raw(
    `
    WITH RECURSIVE tree AS (
      SELECT * FROM territories WHERE id = ?
      UNION ALL
      SELECT t.* FROM territories t
      INNER JOIN tree ON t.parent_id = tree.id
    )
    SELECT * FROM tree WHERE is_active = true
    `,
    [rootId],
  );
  return rows.rows || [];
}

async function listDescendantIds(rootIds) {
  const ids = Array.isArray(rootIds) ? rootIds.filter(Boolean) : [rootIds].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = await db.raw(
    `
    WITH RECURSIVE tree AS (
      SELECT id FROM territories WHERE id = ANY(?::uuid[])
      UNION ALL
      SELECT t.id FROM territories t
      INNER JOIN tree ON t.parent_id = tree.id
    )
    SELECT DISTINCT id FROM tree
    `,
    [ids],
  );
  return (rows.rows || []).map((r) => r.id);
}

async function getAncestors(id) {
  if (!id) return [];
  const rows = await db.raw(
    `
    WITH RECURSIVE chain AS (
      SELECT * FROM territories WHERE id = ?
      UNION ALL
      SELECT t.* FROM territories t
      INNER JOIN chain ON chain.parent_id = t.id
    )
    SELECT * FROM chain WHERE id <> ?
    `,
    [id, id],
  );
  return rows.rows || [];
}

async function getUserTerritories(userId, { includeExpired = false } = {}) {
  const q = db('user_territories as ut')
    .join('territories as t', 't.id', 'ut.territory_id')
    .where('ut.user_id', userId)
    .select(
      'ut.id as assignment_id',
      'ut.territory_id',
      'ut.role_in_territory',
      'ut.valid_from',
      'ut.valid_to',
      't.name',
      't.level',
      't.code',
      't.parent_id',
    );
  if (!includeExpired) q.whereNull('ut.valid_to');
  return q.orderBy('t.name');
}

async function listUsersInTerritory(territoryId) {
  return db('user_territories as ut')
    .join('users as u', 'u.id', 'ut.user_id')
    .where('ut.territory_id', territoryId)
    .whereNull('ut.valid_to')
    .select(
      'u.id',
      'u.email',
      'u.full_name',
      'u.role',
      'u.is_active',
      'ut.role_in_territory',
      'ut.valid_from',
    )
    .orderBy('u.full_name');
}

async function assignUserToTerritory({ userId, territoryId, roleInTerritory = null, assignedBy = null }) {
  const existing = await db('user_territories')
    .where({ user_id: userId, territory_id: territoryId })
    .whereNull('valid_to')
    .first();
  if (existing) return existing;

  const [row] = await db('user_territories')
    .insert({
      user_id: userId,
      territory_id: territoryId,
      role_in_territory: roleInTerritory,
      assigned_by: assignedBy,
    })
    .returning('*');
  return row;
}

async function revokeUserFromTerritory({ userId, territoryId }) {
  return db('user_territories')
    .where({ user_id: userId, territory_id: territoryId })
    .whereNull('valid_to')
    .update({ valid_to: db.fn.now() });
}

async function create({ parentId = null, level, name, code = null, metadata = {} }) {
  const [row] = await db('territories')
    .insert({
      parent_id: parentId,
      level,
      name,
      code,
      metadata: JSON.stringify(metadata || {}),
    })
    .returning('*');
  return row;
}

async function update(id, patch) {
  const allowed = ['name', 'code', 'metadata', 'is_active', 'parent_id'];
  const data = {};
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      data[key] = key === 'metadata' ? JSON.stringify(patch[key] || {}) : patch[key];
    }
  }
  if (Object.keys(data).length === 0) return getById(id);
  data.updated_at = db.fn.now();
  const [row] = await db('territories').where({ id }).update(data).returning('*');
  return row;
}

module.exports = {
  getById,
  getByCode,
  listAll,
  listChildren,
  listDescendants,
  listDescendantIds,
  getAncestors,
  getUserTerritories,
  listUsersInTerritory,
  assignUserToTerritory,
  revokeUserFromTerritory,
  create,
  update,
};
