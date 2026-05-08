const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rangoToRole,
  synthGerenteCode,
  tokenize,
  synthesizeEmail,
  PRIMARY_EMAIL_DOMAIN,
} = require('../../src/modules/bq-sync/jobs/syncCuadroBasico');
const { ROLES } = require('../../src/constants/roles');

test('tokenize — strips diacritics, uppercases, joins with underscore', () => {
  assert.equal(tokenize('GARDUÑO PEREZ LETICIA'), 'GARDUNO_PEREZ_LETICIA');
  assert.equal(tokenize('  jose ramón  '), 'JOSE_RAMON');
  assert.equal(tokenize(''), '');
  assert.equal(tokenize(null), '');
});

test('synthGerenteCode — stable, unique-ish codes per name', () => {
  const a = synthGerenteCode('GARDUÑO PEREZ LETICIA');
  const b = synthGerenteCode('LOAEZA PELAEZ OSCAR');
  const c = synthGerenteCode('FRANCISCO REGIS MONROY');
  assert.equal(a, 'GER_GARDUNO_PEREZ');
  assert.equal(b, 'GER_LOAEZA_PELAEZ');
  assert.equal(c, 'GER_FRANCISCO_REGIS');
  // same name → same code (stable)
  assert.equal(synthGerenteCode('GARDUÑO PEREZ LETICIA'), 'GER_GARDUNO_PEREZ');
});

test('synthGerenteCode — handles missing/empty name with fallback prefix', () => {
  const code = synthGerenteCode('');
  assert.match(code, /^GER_/);
});

test('rangoToRole — Spanish labels map to canonical enum', () => {
  assert.equal(rangoToRole('GERENTE'), ROLES.GERENTE_VENTAS);
  assert.equal(rangoToRole('Gerente'), ROLES.GERENTE_VENTAS);
  assert.equal(rangoToRole('SUPERVISOR'), ROLES.SUPERVISOR);
  assert.equal(rangoToRole('Supervisor de Ventas'), ROLES.SUPERVISOR);
  assert.equal(rangoToRole('REPRESENTANTE'), ROLES.REPRESENTANTE);
  assert.equal(rangoToRole('Agente'), ROLES.REPRESENTANTE);
  assert.equal(rangoToRole('VENDEDOR'), ROLES.REPRESENTANTE);
  assert.equal(rangoToRole('DIRECTOR'), ROLES.DIRECTOR_SUCURSAL);
});

test('rangoToRole — null/empty returns null', () => {
  assert.equal(rangoToRole(null), null);
  assert.equal(rangoToRole(''), null);
});

test('synthesizeEmail — lowercases the employee_code', () => {
  assert.equal(synthesizeEmail('UEA06'), `uea06${PRIMARY_EMAIL_DOMAIN}`);
  assert.equal(synthesizeEmail('GER_GARDUNO_PEREZ'), `ger_garduno_perez${PRIMARY_EMAIL_DOMAIN}`);
  assert.equal(PRIMARY_EMAIL_DOMAIN, '@marzam.mx');
});
