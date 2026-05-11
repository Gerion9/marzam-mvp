const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../../src/modules/users/users.routes');
const controller = require('../../src/modules/users/users.controller');

function findRoute(method, path) {
  return router.stack.find((layer) => (
    layer.route
      && layer.route.path === path
      && Boolean(layer.route.methods[method.toLowerCase()])
  ));
}

// ── Surface guarantees ───────────────────────────────────────────────────

test('users.routes registers GET + PATCH /me/preferences', () => {
  assert.ok(findRoute('get', '/me/preferences'), 'GET /me/preferences');
  assert.ok(findRoute('patch', '/me/preferences'), 'PATCH /me/preferences');
});

test('users.controller exports preference handlers', () => {
  assert.equal(typeof controller.getMyPreferences, 'function');
  assert.equal(typeof controller.updateMyPreferences, 'function');
  assert.equal(typeof controller.sanitizeTutorialPatch, 'function');
});

test('GET /me/preferences runs through authenticate before the handler', () => {
  const layer = findRoute('get', '/me/preferences');
  assert.equal(layer.route.stack.length, 2);
});

test('PATCH /me/preferences runs auth + validate + handler', () => {
  const layer = findRoute('patch', '/me/preferences');
  // authenticate, validate({tutorial}), updateMyPreferences
  assert.equal(layer.route.stack.length, 3);
});

// ── sanitizeTutorialPatch — keep junk out of the jsonb bag ───────────────

test('sanitizeTutorialPatch: returns null for non-object input', () => {
  assert.equal(controller.sanitizeTutorialPatch(null), null);
  assert.equal(controller.sanitizeTutorialPatch(undefined), null);
  assert.equal(controller.sanitizeTutorialPatch('string'), null);
  assert.equal(controller.sanitizeTutorialPatch(42), null);
});

test('sanitizeTutorialPatch: keeps only whitelisted keys', () => {
  const out = controller.sanitizeTutorialPatch({
    seen: true,
    seenAt: '2026-05-10T12:00:00.000Z',
    dismissedForever: false,
    completedTours: ['rep-onboarding'],
    lastTourId: 'rep-capture-visit',
    lastStepIdx: 3,
    // Junk keys — must be dropped
    isAdmin: true,
    role: 'admin',
    arbitraryNested: { evil: true },
  });
  assert.deepEqual(Object.keys(out).sort(), [
    'completedTours', 'dismissedForever', 'lastStepIdx', 'lastTourId', 'seen', 'seenAt',
  ]);
});

test('sanitizeTutorialPatch: validates types per key', () => {
  const out = controller.sanitizeTutorialPatch({
    seen: 'true',           // wrong type — drop
    dismissedForever: 1,    // wrong type — drop
    lastStepIdx: 'three',   // wrong type — drop
    lastTourId: 42,         // wrong type — drop
    completedTours: 'rep',  // wrong type — drop
  });
  assert.deepEqual(out, {});
});

test('sanitizeTutorialPatch: clamps completedTours to 64 and 80 chars', () => {
  const long = 'a'.repeat(200);
  const tours = Array.from({ length: 100 }, (_, i) => `tour-${i}`).concat([long, '', null, 42]);
  const out = controller.sanitizeTutorialPatch({ completedTours: tours });
  assert.ok(Array.isArray(out.completedTours));
  assert.ok(out.completedTours.length <= 64, 'cap at 64 entries');
  assert.ok(out.completedTours.every((s) => typeof s === 'string' && s.length > 0 && s.length < 80));
});

test('sanitizeTutorialPatch: lastStepIdx clamped to [0, 200] integers', () => {
  assert.equal(controller.sanitizeTutorialPatch({ lastStepIdx: -1 }).lastStepIdx, undefined);
  assert.equal(controller.sanitizeTutorialPatch({ lastStepIdx: 201 }).lastStepIdx, undefined);
  assert.equal(controller.sanitizeTutorialPatch({ lastStepIdx: 3.7 }).lastStepIdx, 3);
  assert.equal(controller.sanitizeTutorialPatch({ lastStepIdx: 0 }).lastStepIdx, 0);
});

test('sanitizeTutorialPatch: lastTourId/seenAt rejects > 80 chars', () => {
  const long = 'x'.repeat(81);
  assert.equal(controller.sanitizeTutorialPatch({ lastTourId: long }).lastTourId, undefined);
  assert.equal(controller.sanitizeTutorialPatch({ seenAt: long }).seenAt, undefined);
});

// ── updateMyPreferences shape — empty patch returns 400 ──────────────────

test('updateMyPreferences: 400 when sanitized patch is empty', async () => {
  let statusCode = 0; let payload = null;
  const req = { user: { id: 'u1' }, body: { tutorial: { isAdmin: true } } };
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { payload = b; return this; },
  };
  await controller.updateMyPreferences(req, res, () => {});
  assert.equal(statusCode, 400);
  assert.match(payload.error, /No valid preference keys/);
});

test('updateMyPreferences: 400 when body.tutorial is missing', async () => {
  let statusCode = 0;
  const req = { user: { id: 'u1' }, body: {} };
  const res = { status(c) { statusCode = c; return this; }, json() { return this; } };
  await controller.updateMyPreferences(req, res, () => {});
  assert.equal(statusCode, 400);
});
