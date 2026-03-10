const db = require('../../config/database');
const { isExternalDataMode } = require('../../repositories/runtime');

async function list(filters = {}) {
  if (isExternalDataMode()) {
    return [];
  }

  const q = db('audit_events as ae')
    .leftJoin('users as u', 'u.id', 'ae.user_id')
    .select('ae.*', 'u.full_name as user_name', 'u.email as user_email');

  if (filters.entity_type) q.where('ae.entity_type', filters.entity_type);
  if (filters.entity_id) q.where('ae.entity_id', filters.entity_id);
  if (filters.user_id) q.where('ae.user_id', filters.user_id);
  if (filters.action) q.where('ae.action', filters.action);
  if (filters.from) q.where('ae.created_at', '>=', filters.from);
  if (filters.to) q.where('ae.created_at', '<=', filters.to);

  const page = Number(filters.page) || 1;
  const limit = Math.min(Number(filters.limit) || 50, 500);
  q.limit(limit).offset((page - 1) * limit);
  q.orderBy('ae.created_at', 'desc');

  return q;
}

async function getByEntity(entityType, entityId) {
  if (isExternalDataMode()) {
    return [];
  }

  return db('audit_events')
    .where({ entity_type: entityType, entity_id: entityId })
    .orderBy('created_at', 'desc');
}

module.exports = { list, getByEntity };
