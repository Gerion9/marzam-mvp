const db = require('../../config/database');
const { rolesBelow, canActorManage } = require('../../services/teamScope');
const { normalizeRole } = require('../../constants/roles');

async function listEffective({ branchId = null, channel = 'visit' }) {
  // Returns the set of visit_targets relevant for branchId — branch-specific
  // overrides win over global defaults.
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db('visit_targets')
    .where(function () {
      this.where('branch_id', branchId).orWhereNull('branch_id');
    })
    .andWhere('channel', channel)
    .andWhere('is_active', true)
    .andWhere('effective_from', '<=', today)
    .andWhere(function () {
      this.whereNull('effective_to').orWhere('effective_to', '>=', today);
    })
    .orderBy('pareto_class')
    .orderBy('role');

  // Collapse global vs branch — branch-specific wins per (pareto, role).
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.pareto_class}|${r.role}`;
    const existing = byKey.get(key);
    if (!existing || (existing.branch_id === null && r.branch_id !== null)) {
      byKey.set(key, r);
    }
  }
  return Array.from(byKey.values());
}

async function listOverrides({ subordinateUserId }) {
  return db('visit_target_overrides')
    .where({ subordinate_user_id: subordinateUserId })
    .orderBy('effective_from', 'desc');
}

async function upsertTarget({
  actor,
  branchId,
  paretoClass,
  channel,
  role,
  dailyContactsPerPerson,
  headCount,
  monthlyTarget,
  effectiveFrom,
}) {
  const allowedRoles = rolesBelow(actor.role);
  if (!allowedRoles.includes(normalizeRole(role))) {
    const err = new Error(`Role '${actor.role}' cannot modify targets for '${role}'`);
    err.status = 403;
    throw err;
  }

  // Close any active row for the same key with effective_to = today-1.
  const today = effectiveFrom || new Date().toISOString().slice(0, 10);
  await db('visit_targets')
    .where(function () {
      this.where('branch_id', branchId).orWhere(function () {
        this.whereNull('branch_id').andWhereRaw('? IS NULL', [branchId]);
      });
    })
    .andWhere({ pareto_class: paretoClass, channel: channel || 'visit', role, is_active: true })
    .andWhere('effective_from', '<=', today)
    .andWhere(function () {
      this.whereNull('effective_to').orWhere('effective_to', '>=', today);
    })
    .update({ is_active: false, effective_to: today, updated_at: db.fn.now() });

  const [row] = await db('visit_targets')
    .insert({
      branch_id: branchId,
      pareto_class: paretoClass,
      channel: channel || 'visit',
      role,
      head_count: headCount,
      daily_contacts_per_person: dailyContactsPerPerson,
      monthly_target: monthlyTarget,
      effective_from: today,
      is_active: true,
      created_by: actor.id,
    })
    .returning('*');
  return row;
}

async function createOverride({
  actor,
  subordinateUserId,
  paretoClass,
  channel,
  dailyContactsPerPerson,
  reason,
  effectiveFrom,
}) {
  if (subordinateUserId === actor.id) {
    const err = new Error('Cannot override your own target');
    err.status = 400;
    throw err;
  }
  if (!await canActorManage(actor.id, subordinateUserId)) {
    const err = new Error(`Actor cannot manage user ${subordinateUserId}`);
    err.status = 403;
    throw err;
  }
  const today = effectiveFrom || new Date().toISOString().slice(0, 10);

  // close active overrides for the same key
  await db('visit_target_overrides')
    .where({
      subordinate_user_id: subordinateUserId,
      pareto_class: paretoClass,
      channel: channel || 'visit',
    })
    .andWhere(function () {
      this.whereNull('effective_to').orWhere('effective_to', '>=', today);
    })
    .update({ effective_to: today });

  const [row] = await db('visit_target_overrides')
    .insert({
      subordinate_user_id: subordinateUserId,
      set_by_user_id: actor.id,
      pareto_class: paretoClass,
      channel: channel || 'visit',
      daily_contacts_per_person: dailyContactsPerPerson,
      reason,
      effective_from: today,
    })
    .returning('*');
  return row;
}

async function resolveForUser({ userId, paretoClass, channel = 'visit', date = null }) {
  const onDate = date || new Date().toISOString().slice(0, 10);
  const r = await db.raw('SELECT resolve_visit_target(?, ?::char(1), ?, ?::date) AS v', [
    userId, paretoClass, channel, onDate,
  ]);
  return r.rows?.[0]?.v ?? null;
}

module.exports = {
  listEffective,
  listOverrides,
  upsertTarget,
  createOverride,
  resolveForUser,
};
