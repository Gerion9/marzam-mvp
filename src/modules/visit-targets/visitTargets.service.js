const db = require('../../config/database');
const { rolesBelow, canActorManage } = require('../../services/teamScope');
const { normalizeRole } = require('../../constants/roles');
const { MATRIX_COLUMNS } = require('../../utils/visitCadence');

const ROLES_ORDER = ['director_sucursal', 'gerente_ventas', 'supervisor', 'representante'];

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

  // Collapse global vs branch — branch-specific wins per (pareto, role, category_kind).
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.pareto_class}|${r.role}|${r.category_kind || 'marzam'}`;
    const existing = byKey.get(key);
    if (!existing || (existing.branch_id === null && r.branch_id !== null)) {
      byKey.set(key, r);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Returns the full 4×7 hydrated matrix (4 roles × 7 category columns).
 * Missing cells are filled with defaults (daily_contacts=0, days_share=null).
 */
async function listExpandedMatrix({ branchId = null, channel = 'visit' } = {}) {
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
    });

  // Build lookup: (role, category_kind, pareto_class) → row (branch wins over global)
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.role}|${r.category_kind || 'marzam'}|${r.pareto_class}`;
    const existing = byKey.get(key);
    if (!existing || (existing.branch_id === null && r.branch_id !== null)) {
      byKey.set(key, r);
    }
  }

  // Hydrate 4×7 with zeros for missing cells
  const matrix = [];
  for (const role of ROLES_ORDER) {
    for (const col of MATRIX_COLUMNS) {
      const key = `${role}|${col.category_kind}|${col.pareto_class}`;
      const found = byKey.get(key);
      matrix.push({
        role,
        category_kind: col.category_kind,
        pareto_class: col.pareto_class,
        channel,
        daily_contacts_per_person: found?.daily_contacts_per_person ?? 0,
        days_share: found?.days_share ?? null,
        head_count: found?.head_count ?? null,
        monthly_target: found?.monthly_target ?? null,
        id: found?.id ?? null,
        branch_id: found?.branch_id ?? null,
      });
    }
  }

  return { matrix, branch_id: branchId };
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
  categoryKind = 'marzam',
  daysShare = null,
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

  const today = effectiveFrom || new Date().toISOString().slice(0, 10);

  // Close any active row for the same key
  await db('visit_targets')
    .where(function () {
      this.where('branch_id', branchId).orWhere(function () {
        this.whereNull('branch_id').andWhereRaw('? IS NULL', [branchId]);
      });
    })
    .andWhere({
      pareto_class: paretoClass,
      channel: channel || 'visit',
      role,
      category_kind: categoryKind,
      is_active: true,
    })
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
      category_kind: categoryKind,
      days_share: daysShare != null ? Number(daysShare) : null,
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

/**
 * Upsert multiple cells in a single transaction. Skips cells the actor
 * doesn't have rank to edit (returns ok:false entries) rather than aborting.
 */
async function bulkUpsert({ actor, branchId, cells, channel = 'visit' }) {
  const results = [];
  const today = new Date().toISOString().slice(0, 10);

  await db.transaction(async (trx) => {
    for (const cell of cells) {
      const {
        role,
        category_kind: categoryKind = 'marzam',
        pareto_class: paretoClass,
        daily_contacts_per_person: dailyContactsPerPerson,
        days_share: daysShare = null,
      } = cell;

      const allowedRoles = rolesBelow(actor.role);
      if (!allowedRoles.includes(normalizeRole(role))) {
        results.push({ role, category_kind: categoryKind, pareto_class: paretoClass, ok: false, error: 'unauthorized' });
        continue;
      }

      // Close active row for the same (role, category_kind, pareto_class, branch) key
      await trx('visit_targets')
        .where(function () {
          this.where('branch_id', branchId).orWhere(function () {
            this.whereNull('branch_id').andWhereRaw('? IS NULL', [branchId]);
          });
        })
        .andWhere({ pareto_class: paretoClass, channel, role, category_kind: categoryKind, is_active: true })
        .andWhere('effective_from', '<=', today)
        .andWhere(function () {
          this.whereNull('effective_to').orWhere('effective_to', '>=', today);
        })
        .update({ is_active: false, effective_to: today, updated_at: trx.fn.now() });

      const [row] = await trx('visit_targets')
        .insert({
          branch_id: branchId,
          pareto_class: paretoClass,
          channel,
          role,
          category_kind: categoryKind,
          days_share: daysShare != null ? Number(daysShare) : null,
          daily_contacts_per_person: Number(dailyContactsPerPerson) || 0,
          effective_from: today,
          is_active: true,
          created_by: actor.id,
        })
        .returning('*');
      results.push({ ...row, ok: true });
    }
  });

  return results;
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
  listExpandedMatrix,
  listOverrides,
  upsertTarget,
  bulkUpsert,
  createOverride,
  resolveForUser,
};
