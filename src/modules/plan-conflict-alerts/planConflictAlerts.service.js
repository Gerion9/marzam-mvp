/**
 * plan_conflict_alerts service — list, acknowledge, dismiss, and trigger
 * reoptimize from a pending alert.
 *
 * Reads filtered by branch_id (or by reps the actor manages). Writes guarded
 * by RBAC at the controller layer.
 */

const db = require('../../config/database');
const replanWithHistory = require('../visit-plans/replanWithHistory');

async function list({ branchId = null, status = null, limit = 100 } = {}) {
  const q = db('plan_conflict_alerts as pca')
    .leftJoin('visit_plans as np', 'np.id', 'pca.new_plan_id')
    .leftJoin('visit_plans as cp', 'cp.id', 'pca.conflicting_plan_id')
    .select(
      'pca.id', 'pca.new_plan_id', 'pca.conflicting_plan_id', 'pca.branch_id',
      'pca.conflict_type', 'pca.affected_period_start', 'pca.affected_period_end',
      'pca.severity', 'pca.status', 'pca.resolution_plan_id',
      'pca.acknowledged_at', 'pca.acknowledged_by', 'pca.message', 'pca.payload',
      'pca.created_at',
      db.raw('np.name AS new_plan_name'),
      db.raw('np.granularity AS new_plan_granularity'),
      db.raw('cp.name AS conflicting_plan_name'),
      db.raw('cp.granularity AS conflicting_plan_granularity'),
    )
    .orderBy('pca.created_at', 'desc')
    .limit(Math.min(Number(limit) || 100, 500));
  if (branchId) q.where('pca.branch_id', branchId);
  if (status) q.where('pca.status', status);
  return q;
}

async function getById(id) {
  return db('plan_conflict_alerts').where({ id }).first();
}

async function acknowledge(id, userId) {
  const updated = await db('plan_conflict_alerts')
    .where({ id, status: 'pending' })
    .update({
      status: 'acknowledged',
      acknowledged_at: db.fn.now(),
      acknowledged_by: userId,
    })
    .returning('*');
  if (!updated.length) {
    const err = new Error('Alert not found or no longer pending');
    err.status = 409;
    throw err;
  }
  return updated[0];
}

async function dismiss(id, userId) {
  const updated = await db('plan_conflict_alerts')
    .where({ id })
    .whereIn('status', ['pending', 'acknowledged'])
    .update({
      status: 'dismissed',
      acknowledged_at: db.fn.now(),
      acknowledged_by: userId,
    })
    .returning('*');
  if (!updated.length) {
    const err = new Error('Alert not found or already in terminal state');
    err.status = 409;
    throw err;
  }
  return updated[0];
}

/**
 * Trigger replanWithHistory from the alert's `conflicting_plan_id` (the
 * monthly that got partially superseded). Idempotent: if alert is already
 * status='reoptimized' return the existing resolution_plan_id.
 */
async function reoptimize(id, { triggeredByUserId, planType = 'custom', customStart, customEnd }) {
  const alert = await db('plan_conflict_alerts').where({ id }).first();
  if (!alert) {
    const err = new Error('Alert not found'); err.status = 404; throw err;
  }
  if (alert.status === 'reoptimized' && alert.resolution_plan_id) {
    // Idempotent: return existing resolution_plan_id.
    return { plan_id: alert.resolution_plan_id, already_resolved: true };
  }
  if (!['pending', 'acknowledged'].includes(alert.status)) {
    const err = new Error(`Alert in state '${alert.status}' cannot be reoptimized`);
    err.status = 409;
    throw err;
  }

  // Default range: the portion of the conflicting plan AFTER the colliding window.
  // i.e. "Re-optimizar el resto del mes" = from affected_period_end + 1 to
  // conflicting plan's period_end.
  let cs = customStart;
  let ce = customEnd;
  if (!cs || !ce) {
    const conflictingPlan = await db('visit_plans').where({ id: alert.conflicting_plan_id }).first();
    if (!conflictingPlan) {
      const err = new Error('Conflicting plan not found'); err.status = 404; throw err;
    }
    const affectedEnd = alert.affected_period_end instanceof Date
      ? alert.affected_period_end.toISOString().slice(0, 10)
      : String(alert.affected_period_end).slice(0, 10);
    const monthEnd = conflictingPlan.period_end instanceof Date
      ? conflictingPlan.period_end.toISOString().slice(0, 10)
      : String(conflictingPlan.period_end).slice(0, 10);
    // Day-after affectedEnd.
    const next = new Date(`${affectedEnd}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cs = next.toISOString().slice(0, 10);
    ce = monthEnd;
    if (cs > ce) {
      const err = new Error('No days left in the conflicting plan to reoptimize');
      err.status = 409;
      throw err;
    }
  }

  const result = await replanWithHistory.generate({
    parentPlanId: alert.conflicting_plan_id,
    replanReason: 'desync_resolution',
    triggeredByUserId,
    planType,
    customStart: cs,
    customEnd: ce,
    alertId: id,
  });
  return result;
}

module.exports = {
  list,
  getById,
  acknowledge,
  dismiss,
  reoptimize,
};
