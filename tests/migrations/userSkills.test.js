const test = require('node:test');
const assert = require('node:assert/strict');

const {
  USER_SKILLS,
  USER_SKILLS_CATALOG,
  VALID_SKILL_CODES,
  isValidSkill,
  normalizeSkillsArray,
  userCanVisit,
} = require('../../src/constants/userSkills');

test('USER_SKILLS_CATALOG entries match VALID_SKILL_CODES set', () => {
  // Cada entrada del catálogo debe estar registrada en el set de validación —
  // si alguien añade un skill nuevo y olvida actualizar VALID_SKILL_CODES, los
  // PUT de skills pasarían el filtro pero el frontend no podría listarlo.
  for (const entry of USER_SKILLS_CATALOG) {
    assert.ok(VALID_SKILL_CODES.has(entry.code), `${entry.code} not in VALID_SKILL_CODES`);
    assert.ok(typeof entry.label === 'string' && entry.label.length > 0);
    assert.ok(typeof entry.description === 'string' && entry.description.length > 0);
  }
  assert.equal(USER_SKILLS_CATALOG.length, VALID_SKILL_CODES.size);
});

test('USER_SKILLS constants are exported and present in catalog', () => {
  assert.ok(VALID_SKILL_CODES.has(USER_SKILLS.NEW_PHARMACY_CAPTURE));
  assert.ok(VALID_SKILL_CODES.has(USER_SKILLS.MARZAM_MAINTENANCE));
});

test('isValidSkill: accepts known codes, rejects unknown and bad types', () => {
  assert.equal(isValidSkill('new_pharmacy_capture'), true);
  assert.equal(isValidSkill('marzam_maintenance'), true);
  assert.equal(isValidSkill('not_a_skill'), false);
  assert.equal(isValidSkill(''), false);
  assert.equal(isValidSkill(null), false);
  assert.equal(isValidSkill(undefined), false);
  assert.equal(isValidSkill(42), false);
  assert.equal(isValidSkill({}), false);
});

test('normalizeSkillsArray: dedupes, drops unknowns, sorts, coerces non-arrays to []', () => {
  assert.deepEqual(normalizeSkillsArray(['marzam_maintenance', 'new_pharmacy_capture']),
    ['marzam_maintenance', 'new_pharmacy_capture']);
  // unknown + duplicate + non-string get dropped, order is alphabetical.
  assert.deepEqual(
    normalizeSkillsArray(['new_pharmacy_capture', 'unknown', 'marzam_maintenance', 'new_pharmacy_capture', 42, null]),
    ['marzam_maintenance', 'new_pharmacy_capture'],
  );
  assert.deepEqual(normalizeSkillsArray([]), []);
  assert.deepEqual(normalizeSkillsArray(null), []);
  assert.deepEqual(normalizeSkillsArray(undefined), []);
  assert.deepEqual(normalizeSkillsArray('marzam_maintenance'), []);
  assert.deepEqual(normalizeSkillsArray({ 0: 'marzam_maintenance' }), []);
});

test('userCanVisit: target without required_skills → any user can', () => {
  const user = { user_skills: [] };
  assert.equal(userCanVisit(user, {}), true);
  assert.equal(userCanVisit(user, { required_skills: null }), true);
  assert.equal(userCanVisit(user, { required_skills: [] }), true);
  // Defensive: non-array required_skills (e.g., legacy garbage) treated as null.
  assert.equal(userCanVisit(user, { required_skills: 'marzam_maintenance' }), true);
});

test('userCanVisit: target with required_skills → user must have intersection', () => {
  const target = { required_skills: ['marzam_maintenance'] };
  assert.equal(userCanVisit({ user_skills: ['marzam_maintenance'] }, target), true);
  assert.equal(
    userCanVisit({ user_skills: ['marzam_maintenance', 'new_pharmacy_capture'] }, target),
    true,
  );
  assert.equal(userCanVisit({ user_skills: ['new_pharmacy_capture'] }, target), false);
  assert.equal(userCanVisit({ user_skills: [] }, target), false);
  assert.equal(userCanVisit({ user_skills: null }, target), false);
  assert.equal(userCanVisit({}, target), false);
});

test('userCanVisit: multi-skill target — ANY match suffices (OR semantics, not AND)', () => {
  const target = { required_skills: ['new_pharmacy_capture', 'marzam_maintenance'] };
  assert.equal(userCanVisit({ user_skills: ['new_pharmacy_capture'] }, target), true);
  assert.equal(userCanVisit({ user_skills: ['marzam_maintenance'] }, target), true);
  assert.equal(userCanVisit({ user_skills: [] }, target), false);
});

test('userCanVisit: null target returns true (defensive — caller is responsible for target loading)', () => {
  assert.equal(userCanVisit({ user_skills: ['marzam_maintenance'] }, null), true);
  assert.equal(userCanVisit({ user_skills: ['marzam_maintenance'] }, undefined), true);
});
