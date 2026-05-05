const test = require('node:test');
const assert = require('node:assert/strict');

// Surface tests for the alerts engine. We don't hit the DB; we just lock the
// public contract so future refactors don't drop a function or rename a hot
// path that visits.service.js calls into.

const engine = require('../../src/modules/alerts/alerts.engine');

test('alerts engine exposes the canonical six rules', () => {
  // Hot-path firers (called from inside other modules' transactions).
  assert.equal(typeof engine.fireVisitMissingPhoto, 'function');
  assert.equal(typeof engine.fireCustomerClosed, 'function');
  // Cron evaluators.
  assert.equal(typeof engine.evaluateRepInactivity, 'function');
  assert.equal(typeof engine.evaluateRouteNotStarted, 'function');
  assert.equal(typeof engine.evaluateOnboardingPending, 'function');
  // Orchestrator + feed.
  assert.equal(typeof engine.evaluateAll, 'function');
  assert.equal(typeof engine.feed, 'function');
  assert.equal(typeof engine.resolve, 'function');
});

test('hot-path firers signature accepts the contract used by visits.service', () => {
  // Catches future renames/refactors that would silently break the visits
  // submission path that imports these.  We don't actually invoke them (DB
  // would be required); we only assert arity and existence.
  assert.equal(engine.fireVisitMissingPhoto.length, 1, 'fireVisitMissingPhoto takes one args object');
  assert.equal(engine.fireCustomerClosed.length, 1, 'fireCustomerClosed takes one args object');
});
