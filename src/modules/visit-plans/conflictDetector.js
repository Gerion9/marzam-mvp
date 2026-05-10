/**
 * conflictDetector — invoked inside visitPlans.service.publish() before the
 * archive-en-cascada. Surfaces partial-period collisions with OTHER published
 * plans for the same scope (e.g. publishing a weekly that lands inside an
 * active monthly).
 *
 * Behavior:
 *   1) Discover overlapping non-archived plans with the SAME scope_hash but
 *      DIFFERENT (period_start, period_end).
 *   2) For each, classify the conflict (weekly_overrides_monthly etc.) and
 *      INSERT a `plan_conflict_alerts` row with status='pending'. Unique-index
 *      protects against duplicates on retry.
 *   3) Auto-rescheduled: UPDATE the colliding plan's assignments that fall
 *      INSIDE the new plan's window to status='rescheduled', deviation_reason
 *      set, IF AND ONLY IF reopt_lock_kind is not 'hard' (i.e. the rep hasn't
 *      already started/done that stop).
 *   4) Return summary { alerts: [...], rescheduled_count }.
 *
 * IMPORTANT: this runs inside the publish trx. If publish fails, the alerts
 * and the rescheduled assignments roll back together.
 */

function isoStr(d) {
  if (!d) return d;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function classifyConflict(newGran, oldGran) {
  // Specific known pairs first; fall back to 'custom_overlap'.
  if (newGran === 'weekly' && oldGran === 'monthly') return 'weekly_overrides_monthly';
  if (newGran === 'daily' && oldGran === 'weekly') return 'daily_overrides_weekly';
  if (newGran === 'daily' && oldGran === 'monthly') return 'daily_overrides_monthly';
  return 'custom_overlap';
}

function overlapWindow(a, b) {
  // a, b are { period_start, period_end } as ISO 'YYYY-MM-DD' strings.
  const start = a.period_start > b.period_start ? a.period_start : b.period_start;
  const end = a.period_end < b.period_end ? a.period_end : b.period_end;
  if (start > end) return null;
  return { start, end };
}

/**
 * Detect & record conflicts. Must be called inside an open trx, BEFORE the
 * publish handler archives the parent plan.
 *
 * @param {object} trx     — knex transaction
 * @param {object} newPlan — the plan being published (must have id, scope_hash,
 *                            period_start, period_end, granularity, branch_id)
 * @returns {{alerts: Array, rescheduled_count: number}}
 */
async function detectAndRecordConflicts(trx, newPlan) {
  if (!newPlan?.id || !newPlan?.scope_hash) {
    return { alerts: [], rescheduled_count: 0 };
  }

  // Skip the work entirely if the alerts table isn't deployed yet.
  const hasAlertsTable = await trx.schema.hasTable('plan_conflict_alerts');
  if (!hasAlertsTable) return { alerts: [], rescheduled_count: 0 };

  const newPS = isoStr(newPlan.period_start);
  const newPE = isoStr(newPlan.period_end);

  // Find other non-archived plans with same scope_hash that overlap but are
  // NOT exact same-period (those are handled by the existing archive-en-cascada
  // step in publish — they're full supersedes, not partial conflicts).
  const overlapping = await trx('visit_plans')
    .where('scope_hash', newPlan.scope_hash)
    .whereNot('id', newPlan.id)
    .whereNull('archived_at')
    .whereIn('status', ['published'])
    .where(function () {
      // (NOT (period_end < newPS OR period_start > newPE)) → overlap exists
      this.where('period_start', '<=', newPE)
        .andWhere('period_end', '>=', newPS);
    })
    // Exclude exact same-period (handled by the cascade archive).
    .whereNot(function () {
      this.where('period_start', newPS).andWhere('period_end', newPE);
    })
    .select('id', 'granularity', 'period_start', 'period_end', 'branch_id');

  const alerts = [];
  let rescheduledTotal = 0;

  for (const other of overlapping) {
    const otherPS = isoStr(other.period_start);
    const otherPE = isoStr(other.period_end);
    const window = overlapWindow(
      { period_start: newPS, period_end: newPE },
      { period_start: otherPS, period_end: otherPE },
    );
    if (!window) continue;

    const conflictType = classifyConflict(newPlan.granularity, other.granularity);

    // Auto-reschedule the colliding monthly's "still-planned" assignments
    // that fall inside the new plan's window. Hard-locked stops (in_progress/done
    // already, or marked hard via reopt_lock_kind) are NEVER touched.
    const updatedRows = await trx('visit_plan_assignments')
      .where({ visit_plan_id: other.id })
      .whereBetween('scheduled_date', [window.start, window.end])
      .where('status', 'planned')
      .where(function () {
        this.whereNull('reopt_lock_kind').orWhere('reopt_lock_kind', '!=', 'hard');
      })
      .update({
        status: 'rescheduled',
        deviation_reason: `superseded_by_plan_${newPlan.id}`,
        deviated_at: trx.fn.now(),
      });
    rescheduledTotal += Number(updatedRows || 0);

    // INSERT alert (idempotent via partial unique index).
    try {
      const [inserted] = await trx('plan_conflict_alerts').insert({
        new_plan_id: newPlan.id,
        conflicting_plan_id: other.id,
        branch_id: newPlan.branch_id || other.branch_id || null,
        conflict_type: conflictType,
        affected_period_start: window.start,
        affected_period_end: window.end,
        severity: 'warn',
        status: 'pending',
        message: `Plan ${newPlan.granularity} colisiona parcialmente con un plan ${other.granularity} activo (${otherPS} a ${otherPE}). Asignaciones en la ventana solapada han sido marcadas como rescheduled. Ofrecer CTA "Re-optimizar resto del mes".`,
        payload: {
          new_granularity: newPlan.granularity,
          other_granularity: other.granularity,
          new_period: { start: newPS, end: newPE },
          other_period: { start: otherPS, end: otherPE },
          overlap: { start: window.start, end: window.end },
          rescheduled_in_other: updatedRows,
        },
      }).returning('*');
      if (inserted) alerts.push(inserted);
    } catch (err) {
      // ERR 23505 = unique_violation. Means a pending alert exists already; that's fine.
      if (err.code !== '23505') throw err;
    }
  }

  return { alerts, rescheduled_count: rescheduledTotal };
}

module.exports = {
  detectAndRecordConflicts,
  __classifyConflict: classifyConflict,
  __overlapWindow: overlapWindow,
};
