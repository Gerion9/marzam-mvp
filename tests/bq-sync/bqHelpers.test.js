const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitTable,
  normalizeKey,
  buildKeyMap,
  pickFirst,
  asString,
  asInt,
  asNumeric,
  asBool,
  asDate,
} = require('../../src/modules/bq-sync/bqHelpers');

test('splitTable — handles 1, 2 and 3 part references', () => {
  assert.deepEqual(splitTable('foo'), ['public', 'foo']);
  assert.deepEqual(splitTable('staging.foo'), ['staging', 'foo']);
  assert.deepEqual(splitTable('blackprint_db_prd.staging.foo'), ['staging', 'foo']);
  assert.deepEqual(
    splitTable('"my-db"."my schema"."my-table"'),
    ['my schema', 'my-table'],
  );
});

test('splitTable — throws on empty input', () => {
  assert.throws(() => splitTable(''));
  assert.throws(() => splitTable(null));
});

test('normalizeKey — lowercases, strips diacritics, collapses non-alnum', () => {
  assert.equal(normalizeKey('compañía'), 'compania');
  assert.equal(normalizeKey('Razón Social'), 'razon_social');
  assert.equal(normalizeKey('  __FOO_BAR__  '), 'foo_bar');
  assert.equal(normalizeKey('A&B'), 'a_b');
  assert.equal(normalizeKey(null), '');
});

test('pickFirst — returns first non-empty match by normalized key', () => {
  const row = {
    'compaÑÍa': 'TELCEL',
    'NoMbre': 'Juan',
    other_field: '',
  };
  assert.equal(pickFirst(row, ['compania']), 'TELCEL');
  assert.equal(pickFirst(row, ['nombre', 'apellido']), 'Juan');
  assert.equal(pickFirst(row, ['other_field', 'nombre']), 'Juan',
    'should skip empty strings and continue down the candidate list');
  assert.equal(pickFirst(row, ['missing']), null);
});

test('pickFirst — accepts an explicit keyMap (faster reuse) and is case-insensitive', () => {
  const row = { foo_bar: 1 };
  const km = buildKeyMap(row);
  assert.equal(pickFirst(row, ['foo_bar'], km), 1);
  assert.equal(pickFirst(row, ['FOO_BAR'], km), 1);
  assert.equal(pickFirst(row, ['Foo Bar'], km), 1, 'spaces collapse to underscores');
  // camelCase does NOT auto-split — that would be too magical
  assert.equal(pickFirst(row, ['FooBar'], km), null);
});

test('asString — trims, returns null for empty/whitespace', () => {
  assert.equal(asString('  hello  '), 'hello');
  assert.equal(asString(''), null);
  assert.equal(asString('   '), null);
  assert.equal(asString(null), null);
  assert.equal(asString(42), '42');
});

test('asInt — strips non-numerics and truncates', () => {
  assert.equal(asInt('5'), 5);
  assert.equal(asInt('1,234'), 1234);
  assert.equal(asInt('$1,234.56'), 1234);
  assert.equal(asInt(' 12 '), 12);
  assert.equal(asInt('foo'), null);
  assert.equal(asInt(null), null);
  assert.equal(asInt(''), null);
});

test('asNumeric — preserves decimals', () => {
  assert.equal(asNumeric('3.14'), 3.14);
  assert.equal(asNumeric('-99.06'), -99.06);
  assert.equal(asNumeric('$1,234.56'), 1234.56);
  assert.equal(asNumeric('foo'), null);
});

test('asBool — Spanish + truthy/falsy variants', () => {
  assert.equal(asBool('SI'), true);
  assert.equal(asBool('sí'), true);
  assert.equal(asBool(true), true);
  assert.equal(asBool('1'), true);
  assert.equal(asBool('X'), true);
  assert.equal(asBool('NO'), false);
  assert.equal(asBool(false), false);
  assert.equal(asBool('0'), false);
  assert.equal(asBool('quizas'), null);
  assert.equal(asBool(null), null);
});

test('asDate — handles YMD, DMY, ISO', () => {
  assert.equal(asDate('2026-04-29'), '2026-04-29');
  assert.equal(asDate('2026/04/29'), '2026-04-29');
  assert.equal(asDate('29/04/2026'), '2026-04-29');
  assert.equal(asDate('29-04-2026'), '2026-04-29');
  assert.equal(asDate('2026-4-9'), '2026-04-09');
  assert.equal(asDate('foo'), null);
  assert.equal(asDate(null), null);
  // BQ-style { value: 'YYYY-MM-DD' }
  assert.equal(asDate({ value: '2026-04-29' }), '2026-04-29');
  // JS Date object
  assert.equal(asDate(new Date('2026-04-29T12:00:00Z')), '2026-04-29');
});
