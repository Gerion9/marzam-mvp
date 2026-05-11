const test = require('node:test');
const assert = require('node:assert/strict');

const sm = require('../../src/modules/visits/visits.stateMachine');

test('VISIT_OUTCOMES is the canonical superset', () => {
  // OUTCOMES_REQUIRING_PHOTO must be a subset of VISIT_OUTCOMES.
  for (const o of sm.OUTCOMES_REQUIRING_PHOTO) {
    assert.ok(sm.VISIT_OUTCOMES.includes(o), `${o} not in VISIT_OUTCOMES`);
  }
});

test('OUTCOMES_REQUIRING_PHOTO covers every outcome that touches the pharmacy', () => {
  // Every outcome that creates a visit_report must require a photo (Marzam
  // Execution Doc §6.3 hard-block). The only outcomes optionally exempt are
  // those that explicitly mean "no contact happened" — and we have none of
  // those in the current outcome set.
  for (const o of sm.VISIT_OUTCOMES) {
    assert.ok(
      sm.OUTCOMES_REQUIRING_PHOTO.includes(o),
      `${o} should require a photo per the brief`,
    );
  }
});

test('OUTCOMES_REQUIRING_FOLLOWUP is a subset of VISIT_OUTCOMES', () => {
  for (const o of sm.OUTCOMES_REQUIRING_FOLLOWUP) {
    assert.ok(sm.VISIT_OUTCOMES.includes(o));
  }
});

test('OUTCOMES_SKIPPING_STOP and OUTCOMES_CREATING_FLAG agree', () => {
  // Per §6.3 every "skip" outcome must also be a "flag" outcome (so it goes
  // through the review queue) — they are kept as separate constants for code
  // clarity but the lists must be identical.
  assert.deepStrictEqual([...sm.OUTCOMES_SKIPPING_STOP].sort(), [...sm.OUTCOMES_CREATING_FLAG].sort());
});

test('validateOutcome accepts known and rejects unknown', () => {
  assert.doesNotThrow(() => sm.validateOutcome('interested'));
  assert.doesNotThrow(() => sm.validateOutcome('closed'));
  assert.throws(() => sm.validateOutcome('made_up'));
  assert.throws(() => sm.validateOutcome(''));
  assert.throws(() => sm.validateOutcome(null));
});

test('deprecated outcomes visited/contact_made are rejected', () => {
  // Ratchet against accidentally re-introducing the generic outcomes that
  // Marzam asked to remove (they were opaque to the field rep and duplicated
  // the semantics of `interested` / `needs_follow_up`).
  assert.throws(() => sm.validateOutcome('visited'));
  assert.throws(() => sm.validateOutcome('contact_made'));
});

test('canonical outcomes set has exactly 9 entries', () => {
  // Locks the post-refactor count. Adding/removing outcomes is a product
  // decision — flip the count here intentionally if the set changes.
  assert.strictEqual(sm.VISIT_OUTCOMES.length, 9);
});
