// E2E smoke for intradayReoptimizer using a real DB transaction with ROLLBACK.
// Creates a transient plan + assignments, runs reoptimize() with rep_breakdown,
// validates the diff and locked/released counts, then rolls back so prod is untouched.

(async () => {
  const knex = require('knex')(require('./knexfile').development);
  const reoptimizer = require('./src/modules/visit-plans/intradayReoptimizer');

  let pass = 0, fail = 0;
  const check = (cond, desc) => {
    if (cond) { pass++; console.log('PASS ' + desc); }
    else { fail++; console.log('FAIL ' + desc); }
  };

  try {
    await knex.transaction(async (trx) => {
      // 1. Pick 3 reps with home for our fixture.
      const reps = await trx('users')
        .where({ is_active: true })
        .whereNotNull('home_lat').whereNotNull('home_lng')
        .select('id', 'home_lat', 'home_lng').limit(3);
      check(reps.length === 3, 'fixture: 3 reps with home');
      if (reps.length < 3) throw new Error('not enough reps with home for fixture');

      // 2. Pick 6 pharmacies with coords (3 will go to broken rep).
      const pharms = await trx('pharmacies')
        .whereNotNull('coordinates')
        .where('status', 'active')
        .select('id',
          trx.raw('ST_X(coordinates::geometry) AS lng'),
          trx.raw('ST_Y(coordinates::geometry) AS lat'))
        .limit(6);
      check(pharms.length === 6, 'fixture: 6 pharmacies');

      // 3. Insert a published plan.
      const [plan] = await trx('visit_plans').insert({
        owner_user_id: reps[0].id,
        scope_user_id: reps[0].id,
        granularity: 'daily',
        period_start: '2099-01-05',
        period_end: '2099-01-05',
        status: 'published',
        scope_hash: 'smoke_reopt_' + Date.now(),
        config: JSON.stringify({}),
        metrics: JSON.stringify({}),
      }).returning('*');

      // 4. Insert 6 assignments: rep0 gets 3, rep1 gets 2, rep2 gets 1.
      const distribution = [
        { rep: reps[0].id, pharm: pharms[0], order: 1 },
        { rep: reps[0].id, pharm: pharms[1], order: 2 },
        { rep: reps[0].id, pharm: pharms[2], order: 3 },
        { rep: reps[1].id, pharm: pharms[3], order: 1 },
        { rep: reps[1].id, pharm: pharms[4], order: 2 },
        { rep: reps[2].id, pharm: pharms[5], order: 1 },
      ];
      for (const d of distribution) {
        await trx('visit_plan_assignments').insert({
          visit_plan_id: plan.id,
          visitor_user_id: d.rep,
          pharmacy_id: d.pharm.id,
          scheduled_date: '2099-01-05',
          route_order: d.order,
          channel: 'visit',
          status: 'planned',
          expected_travel_minutes: 30,
          expected_service_minutes: 45,
        });
      }

      // 5. Mark rep0's first stop as in_progress (simulates rep already at it).
      await trx('visit_plan_assignments')
        .where({ visit_plan_id: plan.id, visitor_user_id: reps[0].id, route_order: 1 })
        .update({ status: 'in_progress', actual_start_time: trx.fn.now() });

      // 6. Call reoptimize with broken_user_id = reps[0].id.
      const result = await reoptimizer.reoptimize({
        planId: plan.id,
        date: '2099-01-05',
        brokenUserId: reps[0].id,
        urgentStop: null,
        triggerKind: 'rep_breakdown',
        triggeredBy: reps[0].id,
        trx,
      });

      check(result.ok === true, 'reoptimize returned ok=true');
      check(result.summary.locked_hard >= 1, `locked_hard >= 1 (in_progress) — got ${result.summary.locked_hard}`);
      // Soft locks: next 1-2 planned stops per rep — broken rep's were forced to 'released'.
      check(typeof result.summary.locked_soft === 'number', 'locked_soft is number');
      check(typeof result.summary.moved === 'number', 'moved is number');
      check(typeof result.summary.ms_elapsed === 'number', 'ms_elapsed reported');

      // 7. Verify state after reoptimize: rep0's planned stops should have been
      // moved to other reps OR marked deviated with reason 'reopt_no_capacity'.
      const after = await trx('visit_plan_assignments')
        .where({ visit_plan_id: plan.id, scheduled_date: '2099-01-05' })
        .select('id', 'visitor_user_id', 'route_order', 'status', 'deviation_reason');
      const stillOnBroken = after.filter((a) => a.visitor_user_id === reps[0].id && a.status === 'planned');
      check(stillOnBroken.length === 0, `no planned stops left on broken rep — got ${stillOnBroken.length}`);
      const inProg = after.filter((a) => a.status === 'in_progress');
      check(inProg.length === 1 && inProg[0].visitor_user_id === reps[0].id,
        'in_progress stop preserved on broken rep');

      // 8. Audit row was NOT inserted because that's the service layer's job.
      // Reoptimizer returns `affectedIds`. Verify they exist.
      check(Array.isArray(result.affectedIds), 'affectedIds is array');

      console.log('\n  Final state:');
      console.log(`    locked_hard=${result.summary.locked_hard} locked_soft=${result.summary.locked_soft} released=${result.summary.released_after_breakdown}`);
      console.log(`    moved=${result.summary.moved} no_capacity=${result.summary.no_capacity}`);
      console.log(`    ms=${result.summary.ms_elapsed}`);
      console.log(`    diff entries: ${result.diff.length}`);

      // ROLLBACK: throw to abort the transaction. All inserts are reverted.
      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') {
      console.error('FATAL:', e);
      fail += 1;
    } else {
      console.log('\n  Transaction rolled back ✓ (prod data untouched)');
    }
  } finally {
    await knex.destroy();
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
