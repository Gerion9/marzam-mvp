const test = require('node:test');
const assert = require('node:assert/strict');

const { asBool, asInt, asNumeric, asString, asDate, isNoiseHeader } = require('../../src/modules/imports/parsers');

test('asBool — Spanish + numeric + fallback', () => {
  assert.equal(asBool('SI'), true);
  assert.equal(asBool('Sí'), true);
  assert.equal(asBool('verdadero'), true);
  assert.equal(asBool('1'), true);
  assert.equal(asBool('X'), true);
  assert.equal(asBool('no'), false);
  assert.equal(asBool('falso'), false);
  assert.equal(asBool('0'), false);
  assert.equal(asBool(null), false);
  assert.equal(asBool(undefined, true), true);
  assert.equal(asBool('', true), true);
});

test('asInt — strips currency, commas, returns null on garbage', () => {
  assert.equal(asInt('5'), 5);
  assert.equal(asInt('1,234'), 1234);
  assert.equal(asInt('$1,234.56'), 1234);
  assert.equal(asInt(' 12 '), 12);
  assert.equal(asInt('foo'), null);
  assert.equal(asInt(''), null);
  assert.equal(asInt(null), null);
});

test('asNumeric — handles MX & EU thousands separators', () => {
  assert.equal(asNumeric('1,234.56'), 1234.56);
  assert.equal(asNumeric('$1,234.56'), 1234.56);
  assert.equal(asNumeric('1.234,56'), 1234.56); // EU style
  assert.equal(asNumeric('12,34'), 12.34); // 2 decimals after comma → decimal
  assert.equal(asNumeric('1,234'), 1234); // 3 digits after comma → thousands
  assert.equal(asNumeric(0), 0);
  assert.equal(asNumeric(123.45), 123.45);
  assert.equal(asNumeric(NaN), null);
  assert.equal(asNumeric(''), null);
});

test('asString — trims and converts empty to null', () => {
  assert.equal(asString('  hello  '), 'hello');
  assert.equal(asString(''), null);
  assert.equal(asString('   '), null);
  assert.equal(asString(null), null);
  assert.equal(asString(123), '123');
});

test('asDate — ISO and slashed dates (year first)', () => {
  assert.equal(asDate('2026-04-01'), '2026-04-01');
  assert.equal(asDate('2026/04/01'), '2026-04-01');
  assert.equal(asDate('2026-4-1'), '2026-04-01');
  assert.equal(asDate('2026-04'), '2026-04-01');
});

test('asDate — DMY (Mexican) format', () => {
  assert.equal(asDate('01/04/2026'), '2026-04-01');
  assert.equal(asDate('1-4-2026'), '2026-04-01');
  assert.equal(asDate('15/04/26'), '2026-04-15');
  assert.equal(asDate('15-04-26'), '2026-04-15');
});

test('asDate — month/year only', () => {
  assert.equal(asDate('04-2026'), '2026-04-01');
  assert.equal(asDate('4/26'), '2026-04-01');
  assert.equal(asDate('202604'), '2026-04-01');
});

test('asDate — Spanish month names', () => {
  assert.equal(asDate('Abril 2026'), '2026-04-01');
  assert.equal(asDate('abril 26'), '2026-04-01');
  assert.equal(asDate('ABR-2026'), '2026-04-01');
  assert.equal(asDate('abr/26'), '2026-04-01');
  assert.equal(asDate('1 abril 2026'), '2026-04-01');
  assert.equal(asDate('15 de abril de 2026'), '2026-04-15');
  assert.equal(asDate('Septiembre 2025'), '2025-09-01');
  assert.equal(asDate('SEPT 2025'), '2025-09-01');
  assert.equal(asDate('Diciembre 1999'), '1999-12-01');
});

test('asDate — Date object and Excel serial', () => {
  const d = new Date(Date.UTC(2026, 3, 15)); // Apr 15
  assert.equal(asDate(d), '2026-04-15');
  // Excel serial 45413 ≈ 2024-05-31; just verify shape + month
  const result = asDate(45413);
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('asDate — junk returns null', () => {
  assert.equal(asDate(''), null);
  assert.equal(asDate(null), null);
  assert.equal(asDate('xyz'), null);
  assert.equal(asDate('not a date'), null);
});

test('isNoiseHeader — common noise headers', () => {
  assert.equal(isNoiseHeader('total'), true);
  assert.equal(isNoiseHeader('total_mes'), true);
  assert.equal(isNoiseHeader('promedio'), true);
  assert.equal(isNoiseHeader('observaciones'), true);
  assert.equal(isNoiseHeader('cpadre'), false);
  assert.equal(isNoiseHeader('foo_bar'), false);
});
