const test = require('node:test');
const assert = require('node:assert/strict');

const { ROLES } = require('../../src/constants/roles');
const planGenerator = require('../../src/modules/visit-plans/planGenerator');

// Smoke tests for the role/pareto distribution logic.  We don't run the full
// generator (it needs DB), but we can pull the role-paretos map and verify
// it matches the Marzam Execution Doc §4 contract.

test('ROLE_PRIMARY_PARETO matches Marzam Execution Doc §4', () => {
  const map = planGenerator.ROLE_PRIMARY_PARETO;
  // Director only sees A.
  assert.deepStrictEqual([...map[ROLES.DIRECTOR_SUCURSAL]].sort(), ['A']);
  // Gerente sees A + B.
  assert.deepStrictEqual([...map[ROLES.GERENTE_VENTAS]].sort(), ['A', 'B']);
  // Supervisor sees A + B (per brief: GdS+GdV+Sup visit A; GdV+Sup+Rep visit B).
  assert.deepStrictEqual([...map[ROLES.SUPERVISOR]].sort(), ['A', 'B']);
  // Representante sees B + C.
  assert.deepStrictEqual([...map[ROLES.REPRESENTANTE]].sort(), ['B', 'C']);
});

test('Pareto C is exclusive to Representante (and prospects only via ROLES_THAT_PROSPECT)', () => {
  const map = planGenerator.ROLE_PRIMARY_PARETO;
  const cVisitors = Object.entries(map)
    .filter(([, paretos]) => paretos.includes('C'))
    .map(([role]) => role);
  assert.deepStrictEqual(cVisitors, [ROLES.REPRESENTANTE], 'Only representante should see Pareto C clients');
});
