const db = require('../../config/database');
const { isExternalDataMode } = require('../../repositories/runtime');

const SEVERITY = {
  new_pharmacy: 3,
  chain_not_independent: 3,
  duplicate: 2,
  closed: 2,
  moved: 2,
  wrong_category: 1,
  invalid: 1,
};

const VALID_SORT_COLUMNS = ['created_at', 'flag_type', 'queue_status', 'pharmacy_name'];
const VALID_SORT_DIRS = ['asc', 'desc'];

async function list(filters = {}) {
  if (isExternalDataMode()) {
    return [];
  }

  const q = db('review_queue_items as rq')
    .join('pharmacies as p', 'p.id', 'rq.pharmacy_id')
    .join('users as submitter', 'submitter.id', 'rq.submitted_by')
    .leftJoin('users as reviewer', 'reviewer.id', 'rq.reviewed_by')
    .select(
      'rq.*',
      'p.name as pharmacy_name',
      'p.address as pharmacy_address',
      db.raw(`ST_X(p.coordinates::geometry) AS pharmacy_lng`),
      db.raw(`ST_Y(p.coordinates::geometry) AS pharmacy_lat`),
      'submitter.full_name as submitted_by_name',
      'reviewer.full_name as reviewed_by_name',
      db.raw(`CASE rq.flag_type
        WHEN 'new_pharmacy'          THEN 3
        WHEN 'chain_not_independent' THEN 3
        WHEN 'duplicate'             THEN 2
        WHEN 'closed'                THEN 2
        WHEN 'moved'                 THEN 2
        ELSE 1
      END AS severity`),
    );

  if (filters.queue_status) q.where('rq.queue_status', filters.queue_status);
  if (filters.flag_type) q.where('rq.flag_type', filters.flag_type);
  if (filters.severity) {
    const level = Number(filters.severity);
    if ([1, 2, 3].includes(level)) {
      const types = Object.entries(SEVERITY)
        .filter(([, v]) => v === level)
        .map(([k]) => k);
      q.whereIn('rq.flag_type', types);
    }
  }

  if (filters.sort_by && VALID_SORT_COLUMNS.includes(filters.sort_by)) {
    const dir = VALID_SORT_DIRS.includes(filters.sort_dir) ? filters.sort_dir : 'asc';
    const col = filters.sort_by === 'pharmacy_name' ? 'p.name' : `rq.${filters.sort_by}`;
    q.orderBy(col, dir);
  } else {
    q.orderByRaw(`CASE rq.flag_type
      WHEN 'new_pharmacy'          THEN 3
      WHEN 'chain_not_independent' THEN 3
      WHEN 'duplicate'             THEN 2
      WHEN 'closed'                THEN 2
      WHEN 'moved'                 THEN 2
      ELSE 1
    END DESC, rq.created_at ASC`);
  }

  return q;
}

async function resolve(id, { decision, review_notes, reviewed_by }) {
  if (isExternalDataMode()) {
    const err = new Error('Review queue is disabled in external mode');
    err.status = 501;
    throw err;
  }

  if (!['approved', 'rejected'].includes(decision)) {
    const err = new Error('Decision must be approved or rejected');
    err.status = 422;
    throw err;
  }

  const item = await db('review_queue_items').where({ id }).first();
  if (!item) {
    const err = new Error('Review item not found');
    err.status = 404;
    throw err;
  }
  if (item.queue_status !== 'pending') {
    const err = new Error('Item already resolved');
    err.status = 409;
    throw err;
  }

  return db.transaction(async (trx) => {
    const [updated] = await trx('review_queue_items')
      .where({ id })
      .update({
        queue_status: decision,
        review_notes,
        reviewed_by,
        reviewed_at: trx.fn.now(),
      })
      .returning('*');

    if (decision === 'approved') {
      await applyApprovalSideEffects(trx, item);
    }

    return { before: item, after: updated };
  });
}

async function applyApprovalSideEffects(trx, item) {
  const statusMap = {
    closed: 'closed',
    invalid: 'invalid',
    duplicate: 'duplicate',
    moved: 'moved',
    wrong_category: 'invalid',
    chain_not_independent: 'invalid',
  };

  if (item.flag_type === 'new_pharmacy') {
    await trx('pharmacies')
      .where({ id: item.pharmacy_id })
      .update({ status: 'active', verification_status: 'verified', updated_at: trx.fn.now() });
  } else if (statusMap[item.flag_type]) {
    await trx('pharmacies')
      .where({ id: item.pharmacy_id })
      .update({
        status: statusMap[item.flag_type],
        verification_status: 'verified',
        updated_at: trx.fn.now(),
      });
  }
}

async function batchResolve(ids, { decision, review_notes, reviewed_by }) {
  if (isExternalDataMode()) {
    const err = new Error('Review queue is disabled in external mode');
    err.status = 501;
    throw err;
  }

  if (!['approved', 'rejected'].includes(decision)) {
    const err = new Error('Decision must be approved or rejected');
    err.status = 422;
    throw err;
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    const err = new Error('ids must be a non-empty array');
    err.status = 422;
    throw err;
  }
  if (ids.length > 100) {
    const err = new Error('Cannot batch-resolve more than 100 items at once');
    err.status = 422;
    throw err;
  }

  return db.transaction(async (trx) => {
    const items = await trx('review_queue_items').whereIn('id', ids);

    const notFound = ids.filter((id) => !items.find((i) => i.id === id));
    if (notFound.length) {
      const err = new Error(`Items not found: ${notFound.join(', ')}`);
      err.status = 404;
      throw err;
    }

    const alreadyResolved = items.filter((i) => i.queue_status !== 'pending');
    if (alreadyResolved.length) {
      const err = new Error(
        `Items already resolved: ${alreadyResolved.map((i) => i.id).join(', ')}`,
      );
      err.status = 409;
      throw err;
    }

    const updated = await trx('review_queue_items')
      .whereIn('id', ids)
      .update({
        queue_status: decision,
        review_notes: review_notes || null,
        reviewed_by,
        reviewed_at: trx.fn.now(),
      })
      .returning('*');

    if (decision === 'approved') {
      for (const item of items) {
        await applyApprovalSideEffects(trx, item);
      }
    }

    return { count: updated.length, items: updated };
  });
}

async function pendingCount() {
  if (isExternalDataMode()) {
    return 0;
  }

  const result = await db('review_queue_items')
    .where({ queue_status: 'pending' })
    .count('id as cnt')
    .first();
  return Number(result.cnt);
}

module.exports = { list, resolve, batchResolve, pendingCount };
