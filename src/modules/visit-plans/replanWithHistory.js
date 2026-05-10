/**
 * replanWithHistory — generate a new plan that supersedes an existing one,
 * respecting recent visit cadence and producing an explicit lineage link.
 *
 * Why this exists separate from planGenerator.generate():
 *   - `generate` enforces the "no other non-archived plan for this scope+period"
 *     invariant via a SELECT-then-INSERT under advisory lock. A naive call from
 *     the conflict-alert CTA would always throw 409.
 *   - The replan needs to atomically (a) archive the parent, (b) write the new
 *     plan with parent_plan_id + version, and (c) optionally resolve the alert
 *     that triggered it. All within ONE transaction so a crash mid-flight can
 *     never leave two non-archived plans or a dangling alert.
 *
 * Cadence rules applied as exclusion windows (a pharmacy visited within the
 * window is dropped from the candidate pool):
 *
 *   pareto A → 7  days  (target 4/mo, weekly cadence)
 *   pareto B → 14 days  (target 2/mo, bi-weekly)
 *   pareto C → 30 days  (target 1/mo, monthly)
 *   pareto D → 60 days  (target 0.5/mo, bi-monthly prospects)
 *
 * Inputs:
 *   {
 *     parentPlanId:    UUID of the plan being replaced. Must be status='published'
 *                      and not yet archived.
 *     replanReason:    'mid_flight' | 'rep_breakdown' | 'desync_resolution' | 'manual_override'
 *     triggeredByUserId: who pressed "generate".
 *     planType:        'daily' | 'weekly' | 'monthly' | 'custom'
 *     customStart, customEnd: when planType='custom'
 *     paretoFilter:    optional subset (defaults to parent's)
 *     alertId:         optional — when set, the linked plan_conflict_alerts row
 *                      is moved to status='reoptimized' atomically.
 *     cadenceWindowDays: how far back to look at history (default 60).
 *   }
 *
 * Output:
 *   { plan, assignmentsInserted, excluded, parentArchived: true }
 */

const crypto = require('crypto');
const db = require('../../config/database');
const planGenerator = require('./planGenerator');
const planEngine = require('../../services/planEngine');
const branchPlanSettings = require('../../services/branchPlanSettings');

// Marzam cadence per pareto letter (visits/month → exclusion window in days).
const CADENCE_EXCLUSION_DAYS = Object.freeze({
  A: 7,
  B: 14,
  C: 30,
  D: 60,
});

function lockKeyFor(scopeHash, periodStart, periodEnd) {
  const buf = crypto
    .createHash('md5')
    .update(`${scopeHash}|${periodStart}|${periodEnd}`)
    .digest();
  return buf.readBigInt64BE(0).toString();
}

/**
 * Load (pharmacy_id|marzam_client_id) → last_completed_at for the scope's
 * recent visit history. Excludes soft-deleted rows when the column exists.
 */
async function loadRecentVisitHistory(trx, scopeUserIds, sinceIso) {
  // visit_reports.deleted_at may not exist before mig 088 — guard via column probe.
  const hasDeletedAt = await trx.schema.hasColumn('visit_reports', 'deleted_at').catch(() => false);

  // Two passes: completed assignments from prior plans (canonical signal) + raw
  // visit_reports (covers visits done without a plan, e.g. retroactive entry).
  const fromAssignments = await trx('visit_plan_assignments as vpa')
    .where('vpa.status', 'done')
    .where('vpa.completed_at', '>=', sinceIso)
    .whereIn('vpa.visitor_user_id', scopeUserIds)
    .select('vpa.pharmacy_id', 'vpa.marzam_client_id', 'vpa.completed_at');

  const reportsQ = trx('visit_reports as vr')
    .where('vr.rep_id', 'in', scopeUserIds)
    .where('vr.created_at', '>=', sinceIso)
    .select('vr.pharmacy_id', 'vr.created_at as completed_at');
  if (hasDeletedAt) reportsQ.whereNull('vr.deleted_at');
  const fromReports = await reportsQ;

  // Build the latest-visit map keyed by pharmacy_id OR marzam_client_id (XOR).
  const lastByPharmacy = new Map();
  const lastByClient = new Map();
  for (const r of fromAssignments) {
    if (r.marzam_client_id) {
      const cur = lastByClient.get(r.marzam_client_id);
      if (!cur || r.completed_at > cur) lastByClient.set(r.marzam_client_id, r.completed_at);
    }
    if (r.pharmacy_id) {
      const cur = lastByPharmacy.get(r.pharmacy_id);
      if (!cur || r.completed_at > cur) lastByPharmacy.set(r.pharmacy_id, r.completed_at);
    }
  }
  for (const r of fromReports) {
    if (!r.pharmacy_id) continue;
    const cur = lastByPharmacy.get(r.pharmacy_id);
    if (!cur || r.completed_at > cur) lastByPharmacy.set(r.pharmacy_id, r.completed_at);
  }
  return { lastByPharmacy, lastByClient };
}

/**
 * Decide whether a candidate should be excluded based on its last-visit date
 * and its pareto class. Mutates `excluded` list with reason strings.
 */
function shouldExclude({ pareto, lastVisitedAt, now }) {
  const windowDays = CADENCE_EXCLUSION_DAYS[pareto];
  if (!windowDays || !lastVisitedAt) return false;
  const ageMs = now.getTime() - new Date(lastVisitedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return ageDays < windowDays;
}

/**
 * Compute the next version number across the entire lineage (root → leaf chain),
 * not just parent.version + 1. This prevents version collisions when the lineage
 * has branches (e.g. rep_breakdown + desync_resolution generated independently).
 */
async function nextLineageVersion(trx, parentPlanId) {
  // CTE walking up to the root via parent_plan_id, then back down via
  // superseded_by_plan_id to get the entire lineage. Simpler: collect any
  // plan that shares the root.
  const rows = await trx.raw(`
    WITH RECURSIVE up AS (
      SELECT id, parent_plan_id, version FROM visit_plans WHERE id = ?::uuid
      UNION ALL
      SELECT p.id, p.parent_plan_id, p.version
        FROM visit_plans p JOIN up ON up.parent_plan_id = p.id
    ), root AS (SELECT id FROM up WHERE parent_plan_id IS NULL),
    down AS (
      SELECT id, parent_plan_id, version FROM visit_plans
       WHERE id IN (SELECT id FROM root)
      UNION ALL
      SELECT p.id, p.parent_plan_id, p.version
        FROM visit_plans p JOIN down ON p.parent_plan_id = down.id
    )
    SELECT COALESCE(MAX(version), 1) AS max_version FROM down
  `, [parentPlanId]);
  const maxV = rows.rows?.[0]?.max_version || 1;
  return Number(maxV) + 1;
}

async function generate({
  parentPlanId,
  replanReason,
  triggeredByUserId,
  planType,
  customStart,
  customEnd,
  paretoFilter = null,
  alertId = null,
  cadenceWindowDays = 60,
}) {
  if (!parentPlanId) throw Object.assign(new Error('parentPlanId required'), { status: 400 });
  if (!['mid_flight', 'rep_breakdown', 'desync_resolution', 'manual_override'].includes(replanReason)) {
    throw Object.assign(new Error(`Invalid replan_reason: ${replanReason}`), { status: 400 });
  }
  if (!['daily', 'weekly', 'monthly', 'custom'].includes(planType)) {
    throw Object.assign(new Error(`Invalid planType: ${planType}`), { status: 400 });
  }
  if (!triggeredByUserId) throw Object.assign(new Error('triggeredByUserId required'), { status: 400 });

  return db.transaction(async (trx) => {
    // 1. Load parent plan FOR UPDATE. This blocks a concurrent intradayReoptimizer
    //    that takes the same row lock, so the parent's status is stable for the
    //    duration of the replan.
    const parent = await trx('visit_plans').where({ id: parentPlanId }).forUpdate().first();
    if (!parent) {
      throw Object.assign(new Error('parent plan not found'), { status: 404 });
    }
    if (parent.status !== 'published' || parent.archived_at) {
      throw Object.assign(
        new Error(`parent plan must be published+not archived (status=${parent.status})`),
        { status: 409 },
      );
    }

    // 2. Advisory lock — same key as planGenerator.generate / visitPlans.publish.
    //    Serializes ANY concurrent publish/generate against this scope+period.
    if (parent.scope_hash) {
      const periodStartStr = parent.period_start instanceof Date
        ? parent.period_start.toISOString().slice(0, 10)
        : String(parent.period_start);
      const periodEndStr = parent.period_end instanceof Date
        ? parent.period_end.toISOString().slice(0, 10)
        : String(parent.period_end);
      const lockBig = lockKeyFor(parent.scope_hash, periodStartStr, periodEndStr);
      await trx.raw('SELECT pg_advisory_xact_lock(?::bigint)', [lockBig]);
    }

    // 3. Resolve the new window via planEngine + branch settings.
    const bs = await branchPlanSettings.get(parent.branch_id);
    const win = planEngine.resolveWindow({
      now: new Date(),
      planType,
      customStart,
      customEnd,
      branchSettings: bs,
    });
    if (!win.working_dates.length) {
      throw Object.assign(new Error('no working days in resolved window'), { status: 400 });
    }

    // 4. Determine scope_user_ids from the parent (use distinct visitors in
    //    assignments — that's the authoritative scope).
    const scopeRows = await trx('visit_plan_assignments')
      .where({ visit_plan_id: parentPlanId })
      .distinct('visitor_user_id');
    const scopeUserIds = scopeRows.map((r) => r.visitor_user_id);
    if (!scopeUserIds.length) {
      throw Object.assign(new Error('parent plan has no assignments — nothing to replan'), { status: 409 });
    }

    // 5. Load recent visit history (last `cadenceWindowDays` days).
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - cadenceWindowDays);
    const sinceIso = sinceDate.toISOString();
    const { lastByPharmacy, lastByClient } = await loadRecentVisitHistory(trx, scopeUserIds, sinceIso);

    // 6. Compute lineage version.
    const newVersion = await nextLineageVersion(trx, parentPlanId);

    // 7. Build the new plan via planGenerator.buildPlan (transaction-aware).
    //    We pass the same trx so candidate fetches respect the row locks we hold.
    const buildArgs = {
      ownerUserId: triggeredByUserId,
      scopeUserIds,
      granularity: planType === 'custom' ? 'monthly' : planType, // 'custom' is not in the granularity enum
      periodStart: win.period_start,
      periodEnd: win.period_end,
      paretoFilter: paretoFilter || planGenerator.PARETO_CLASSES,
      branchId: parent.branch_id,
      name: `${parent.name || 'plan'} (v${newVersion})`,
      // generate path: 'persist'. We override INSERT below to add lineage fields.
      actorIsGlobal: true, // replan from supervisor+ already authorized at the controller layer
    };
    const { planDraft, assignmentRows } = await planGenerator.buildPlan(buildArgs, trx, 'persist');

    // 8. Filter assignments by cadence exclusion. Excluded rows are dropped
    //    AND logged so the UI can show "12 stops skipped — visited recently".
    const excluded = [];
    const now = new Date();
    const filteredAssignments = assignmentRows.filter((r) => {
      const pareto = r.pareto;
      if (!pareto) return true;
      const last = r.marzam_client_id
        ? lastByClient.get(r.marzam_client_id)
        : lastByPharmacy.get(r.pharmacy_id);
      const skip = shouldExclude({ pareto, lastVisitedAt: last, now });
      if (skip) {
        excluded.push({
          marzam_client_id: r.marzam_client_id || null,
          pharmacy_id: r.pharmacy_id || null,
          pareto,
          last_visited_at: last,
          reason: `cadence_window_${CADENCE_EXCLUSION_DAYS[pareto]}d`,
        });
      }
      return !skip;
    });

    // 9. Augment planDraft with lineage fields (mig 086) before INSERT.
    const draftWithLineage = {
      ...planDraft,
      parent_plan_id: parentPlanId,
      version: newVersion,
      replan_reason: replanReason,
      triggered_by_user_id: triggeredByUserId,
      cutoff_at: win.cutoff_at,
      working_days_snapshot: win.working_days_snapshot,
    };

    // 10. Mark parent as superseded BEFORE INSERTing the child. This frees the
    //     scope_hash+period uniqueness slot so the INSERT can succeed.
    await trx('visit_plans')
      .where({ id: parentPlanId })
      .update({
        status: 'archived',
        archived_at: trx.fn.now(),
        // superseded_by_plan_id filled after we know the new id
        updated_at: trx.fn.now(),
      });

    // 11. INSERT the new plan (status='draft' by default — caller will publish
    //     after they review). Configurable later if desync_resolution should
    //     auto-publish.
    const [plan] = await trx('visit_plans').insert(draftWithLineage).returning('*');

    // 12. Now backfill parent.superseded_by_plan_id.
    await trx('visit_plans')
      .where({ id: parentPlanId })
      .update({ superseded_by_plan_id: plan.id });

    // 13. INSERT assignments.
    let assignmentsInserted = 0;
    if (filteredAssignments.length) {
      const insertRows = filteredAssignments.map((r) => {
        const row = { visit_plan_id: plan.id };
        for (const col of planGenerator.DB_ASSIGNMENT_COLS) row[col] = r[col];
        return row;
      });
      const CHUNK = 250;
      for (let i = 0; i < insertRows.length; i += CHUNK) {
        const slice = insertRows.slice(i, i + CHUNK);
        const inserted = await trx('visit_plan_assignments').insert(slice).returning('id');
        assignmentsInserted += inserted.length;
      }
    }

    // 14. Resolve the conflict alert if this replan was triggered from one.
    //     Guarded: plan_conflict_alerts table may not exist before mig 087.
    if (alertId) {
      const hasAlertsTable = await trx.schema.hasTable('plan_conflict_alerts');
      if (hasAlertsTable) {
        await trx('plan_conflict_alerts')
          .where({ id: alertId, status: 'pending' })
          .update({
            status: 'reoptimized',
            resolution_plan_id: plan.id,
            acknowledged_at: trx.fn.now(),
            acknowledged_by: triggeredByUserId,
          });
      }
    }

    // 15. Audit log.
    const hasAuditEvents = await trx.schema.hasTable('audit_events');
    if (hasAuditEvents) {
      await trx('audit_events').insert({
        user_id: triggeredByUserId,
        action: 'visit_plan.replan',
        entity_type: 'visit_plan',
        entity_id: plan.id,
        before_state: { parent_plan_id: parentPlanId, status: 'published' },
        after_state: {
          id: plan.id, version: newVersion, replan_reason: replanReason,
          excluded_count: excluded.length, assignments_inserted: assignmentsInserted,
        },
      }).catch(() => { /* audit_events insert is best-effort */ });
    }

    return {
      plan,
      parent_plan_id: parentPlanId,
      parent_archived: true,
      assignments_inserted: assignmentsInserted,
      excluded,
      version: newVersion,
      replan_reason: replanReason,
    };
  });
}

module.exports = {
  generate,
  CADENCE_EXCLUSION_DAYS,
  __shouldExclude: shouldExclude,
  __nextLineageVersion: nextLineageVersion,
};
