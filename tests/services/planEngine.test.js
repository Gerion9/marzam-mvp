/**
 * planEngine.resolveWindow — pin down cutoff, working days, and granularity math.
 *
 * Time of day reasoning is done in America/Mexico_City (UTC-6). The tests build
 * UTC `Date`s such that the corresponding CDMX wall-clock hits the boundary we
 * care about. CDMX has no DST since 2022, so UTC-6 is fixed year-round.
 *
 * Convention: working_days are JS getDay indices (0=Sun..6=Sat). Marzam default
 * is [0..5] = Dom..Vie, Sábado siempre inhábil.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const planEngine = require('../../src/services/planEngine');
const { DEFAULTS } = require('../../src/services/branchPlanSettings');

// Build a UTC Date whose CDMX wall-clock is the given (Y-M-D HH:MM).
function cdmx(y, m, d, hh, mm = 0) {
  // CDMX = UTC-6. To get CDMX wall = HH, set UTC = HH+6.
  return new Date(Date.UTC(y, m - 1, d, hh + 6, mm, 0));
}

test('cutoff edge — 08:29 CDMX (before 08:30) → daily plan owns today (if working)', () => {
  // Mon 4 May 2026 08:29 CDMX, monday is a working day.
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 5, 4, 8, 29),
    planType: 'daily',
    branchSettings: DEFAULTS,
  });
  assert.equal(w.before_cutoff, true);
  assert.equal(w.period_start, '2026-05-04');
  assert.equal(w.period_end, '2026-05-04');
});

test('cutoff edge — 08:31 CDMX (after 08:30) → daily plan shifts to next working day', () => {
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 5, 4, 8, 31),
    planType: 'daily',
    branchSettings: DEFAULTS,
  });
  assert.equal(w.before_cutoff, false);
  assert.equal(w.period_start, '2026-05-05'); // Tuesday
  assert.equal(w.period_end, '2026-05-05');
});

test('cutoff edge — exact 08:30 → treated as "after" (>= cutoff)', () => {
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 5, 4, 8, 30),
    planType: 'daily',
    branchSettings: DEFAULTS,
  });
  // String compare '08:30' < '08:30' is false → beforeCutoff=false → shifts.
  assert.equal(w.before_cutoff, false);
  assert.equal(w.period_start, '2026-05-05');
});

test('TZ flip — 23:59 CDMX Sunday vs 00:00 CDMX Monday are different days', () => {
  // 2026-05-03 23:59 CDMX (Sun) → UTC 2026-05-04 05:59
  const sun2359 = cdmx(2026, 5, 3, 23, 59);
  // 2026-05-04 00:00 CDMX (Mon) → UTC 2026-05-04 06:00
  const mon0000 = cdmx(2026, 5, 4, 0, 0);

  // Sunday IS a working day in Marzam default (Dom-Vie). 23:59 > 08:30 cutoff
  // so we shift to next working day.
  const wSun = planEngine.resolveWindow({
    now: sun2359, planType: 'daily', branchSettings: DEFAULTS,
  });
  assert.equal(wSun.period_start, '2026-05-04', 'Sun 23:59 (after cutoff) → Monday');

  // Mon 00:00 < 08:30 cutoff → owns today (Monday).
  const wMon = planEngine.resolveWindow({
    now: mon0000, planType: 'daily', branchSettings: DEFAULTS,
  });
  assert.equal(wMon.period_start, '2026-05-04', 'Mon 00:00 (before cutoff) → owns today');
  assert.equal(wMon.before_cutoff, true);
});

test('working days default [0..5] — Saturday is always skipped', () => {
  // Sat 9 May 2026 07:00 CDMX (before cutoff) — Saturday is NOT a working day,
  // so even with before_cutoff, candidateStart bumps to Sunday (=working).
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 5, 9, 7, 0),
    planType: 'daily',
    branchSettings: DEFAULTS,
  });
  assert.equal(w.before_cutoff, true);
  assert.equal(w.period_start, '2026-05-10', 'Sat bumps to Sun (which is working)');
});

test('working days — branch with Mon-Fri only [1..5] excludes Sunday', () => {
  // Sun 10 May 2026 07:00 CDMX, settings exclude Sunday.
  const monFri = { ...DEFAULTS, working_days: [1, 2, 3, 4, 5] };
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 5, 10, 7, 0),
    planType: 'daily',
    branchSettings: monFri,
  });
  assert.equal(w.period_start, '2026-05-11', 'Sun bumps to Mon when Sun not working');
});

test('weekly plan — Tuesday 09:00 (after cutoff) → Wed..Fri', () => {
  // Tue 5 May 2026 09:00 CDMX (after 08:30). With Dom-Vie default working days,
  // candidateStart = next working = Wed 6 May. End of work-week = Fri 8 May.
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 5, 5, 9, 0),
    planType: 'weekly',
    branchSettings: DEFAULTS,
  });
  assert.equal(w.period_start, '2026-05-06');
  assert.equal(w.period_end, '2026-05-08');
  assert.deepEqual(w.working_dates, ['2026-05-06', '2026-05-07', '2026-05-08']);
});

test('weekly plan — Tuesday 07:00 (before cutoff) → Tue..Fri', () => {
  // Tue 5 May 2026 07:00 CDMX (before 08:30). candidateStart = today = Tue.
  // End of work-week = Fri 8 May.
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 5, 5, 7, 0),
    planType: 'weekly',
    branchSettings: DEFAULTS,
  });
  assert.equal(w.period_start, '2026-05-05');
  assert.equal(w.period_end, '2026-05-08');
});

test('monthly plan — published 5 May → period_end is last working day of May, not 5 June', () => {
  // Tue 5 May 2026 07:00 CDMX (before cutoff). Last day of May = Sunday 31 May,
  // which IS a working day in Dom-Vie. So periodEnd = 2026-05-31.
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 5, 5, 7, 0),
    planType: 'monthly',
    branchSettings: DEFAULTS,
  });
  assert.equal(w.period_start, '2026-05-05');
  assert.equal(w.period_end, '2026-05-31', 'monthly clips to last working day of month');
  // Saturday 30 May is excluded from working_dates.
  assert.ok(!w.working_dates.includes('2026-05-30'), 'Sat May 30 not a working day');
  assert.ok(w.working_dates.includes('2026-05-31'), 'Sun May 31 is a working day');
});

test('monthly plan — Mon-Fri branch on month ending Saturday', () => {
  // 31 January 2026 is a Saturday. Mon-Fri branch should clip to Fri 30 Jan.
  const monFri = { ...DEFAULTS, working_days: [1, 2, 3, 4, 5] };
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 1, 5, 7, 0), // Mon 5 Jan 07:00
    planType: 'monthly',
    branchSettings: monFri,
  });
  assert.equal(w.period_start, '2026-01-05');
  assert.equal(w.period_end, '2026-01-30', 'last working day of Jan is Fri 30 (Mon-Fri)');
});

test('custom plan — range crossing month boundary, Saturdays excluded', () => {
  // Custom 25 April 2026 (Sat) → 10 May 2026 (Sun). Sat 25 Apr is skipped at
  // the start, Sat 2 May and 9 May excluded from working_dates. End Sun 10 May
  // is a working day (Dom-Vie).
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 4, 20, 7, 0),
    planType: 'custom',
    customStart: '2026-04-25',
    customEnd: '2026-05-10',
    branchSettings: DEFAULTS,
  });
  assert.equal(w.period_start, '2026-04-26', 'Sat 25 Apr bumps to Sun 26 Apr');
  assert.equal(w.period_end, '2026-05-10');
  // Saturdays not in working_dates.
  assert.ok(!w.working_dates.includes('2026-05-02'));
  assert.ok(!w.working_dates.includes('2026-05-09'));
  // Sundays ARE in working_dates (Dom-Vie default).
  assert.ok(w.working_dates.includes('2026-04-26'));
  assert.ok(w.working_dates.includes('2026-05-03'));
});

test('custom plan — both endpoints fall on Saturdays', () => {
  // Custom 2026-05-02 (Sat) → 2026-05-23 (Sat). Start bumps to Sun 3, end
  // walks back to Fri 22.
  const w = planEngine.resolveWindow({
    now: cdmx(2026, 5, 1, 7, 0),
    planType: 'custom',
    customStart: '2026-05-02',
    customEnd: '2026-05-23',
    branchSettings: DEFAULTS,
  });
  assert.equal(w.period_start, '2026-05-03');
  assert.equal(w.period_end, '2026-05-22');
});

test('custom plan — invalid args throw', () => {
  assert.throws(() => planEngine.resolveWindow({
    now: cdmx(2026, 5, 1, 7, 0), planType: 'custom', branchSettings: DEFAULTS,
  }), /customStart and customEnd/);

  assert.throws(() => planEngine.resolveWindow({
    now: cdmx(2026, 5, 1, 7, 0),
    planType: 'custom',
    customStart: '2026-05-10', customEnd: '2026-05-01',
    branchSettings: DEFAULTS,
  }), /customEnd must be >= customStart/);
});

test('snapshot fields — cutoff_at and working_days_snapshot are frozen', () => {
  const now = cdmx(2026, 5, 4, 7, 0);
  const customSettings = { ...DEFAULTS, working_days: [1, 2, 3, 4, 5] };
  const w = planEngine.resolveWindow({
    now, planType: 'daily', branchSettings: customSettings,
  });
  assert.equal(w.cutoff_at, now.toISOString());
  assert.deepEqual(w.working_days_snapshot, [1, 2, 3, 4, 5]);
  // Mutating the snapshot doesn't affect the original.
  w.working_days_snapshot.push(99);
  assert.deepEqual(customSettings.working_days, [1, 2, 3, 4, 5]);
});

test('unknown planType throws', () => {
  assert.throws(() => planEngine.resolveWindow({
    now: cdmx(2026, 5, 1, 7, 0), planType: 'yearly', branchSettings: DEFAULTS,
  }), /Unknown planType/);
});

test('isWorkingDay, eachWorkingDay, lastWorkingDayOfMonth — primitives', () => {
  assert.equal(planEngine.isWorkingDay('2026-05-09', [0, 1, 2, 3, 4, 5]), false, 'Sat skipped');
  assert.equal(planEngine.isWorkingDay('2026-05-10', [0, 1, 2, 3, 4, 5]), true, 'Sun included');
  assert.equal(planEngine.isWorkingDay('2026-05-11', [1, 2, 3, 4, 5]), true, 'Mon');

  const week = planEngine.eachWorkingDay('2026-05-04', '2026-05-10', [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(week, [
    '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08', '2026-05-10',
  ], 'Sat 9 May skipped');

  assert.equal(planEngine.lastWorkingDayOfMonth('2026-01-01', [1, 2, 3, 4, 5]), '2026-01-30');
  assert.equal(planEngine.lastWorkingDayOfMonth('2026-05-01', [0, 1, 2, 3, 4, 5]), '2026-05-31');
});
