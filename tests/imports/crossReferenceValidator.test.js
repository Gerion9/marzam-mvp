'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  validateCrossReferences,
  _validateEmployees,
  _validateMarzamClients,
  _validateDailySales,
} = require('../../src/modules/imports/crossReferenceValidator');

/**
 * Build a trx-like callable from a fixture map: { table_name: [rows] }.
 * Supports: trx(table).whereIn(col, vals).select(...cols) → Promise<rows>.
 */
function makeMockTrx(mockData) {
  return function trx(table) {
    let whereInCond = null;
    const builder = {
      whereIn(col, vals) {
        whereInCond = { col, vals: new Set(vals) };
        return builder;
      },
      select(...cols) {
        const rows = mockData[table] || [];
        const filtered = whereInCond
          ? rows.filter((r) => whereInCond.vals.has(r[whereInCond.col]))
          : rows;
        return Promise.resolve(filtered.map((r) => {
          if (cols.length === 0) return r;
          const out = {};
          for (const c of cols) out[c] = r[c];
          return out;
        }));
      },
    };
    return builder;
  };
}

// ---------- employees ----------

test('employees: happy path returns no errors', async () => {
  const rows = [
    { rowNumber: 2, row: { employee_code: 'EMP001', email: 'a@x.com', manager_employee_code: null } },
    { rowNumber: 3, row: { employee_code: 'EMP002', email: 'b@x.com', manager_employee_code: 'EMP001' } },
  ];
  const trx = makeMockTrx({ users: [] });
  const { errors, warnings } = await _validateEmployees(trx, rows);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
});

test('employees: duplicate employee_code within batch', async () => {
  const rows = [
    { rowNumber: 2, row: { employee_code: 'EMP001', email: 'a@x.com' } },
    { rowNumber: 3, row: { employee_code: 'EMP001', email: 'b@x.com' } },
  ];
  const trx = makeMockTrx({ users: [] });
  const { errors } = await _validateEmployees(trx, rows);
  const dup = errors.find((e) => e.code === 'DUPLICATE_IN_BATCH');
  assert.ok(dup, 'expected DUPLICATE_IN_BATCH error');
  assert.equal(dup.row, 3);
});

test('employees: email collision with different employee_code in DB', async () => {
  const rows = [
    { rowNumber: 2, row: { employee_code: 'NEW001', email: 'taken@x.com' } },
  ];
  const trx = makeMockTrx({
    users: [{ email: 'taken@x.com', employee_code: 'EXISTING001' }],
  });
  const { errors } = await _validateEmployees(trx, rows);
  const e = errors.find((x) => x.code === 'EMAIL_COLLISION');
  assert.ok(e);
});

test('employees: email matches same employee_code (upsert) is allowed', async () => {
  const rows = [
    { rowNumber: 2, row: { employee_code: 'EXISTING001', email: 'a@x.com' } },
  ];
  const trx = makeMockTrx({
    users: [{ email: 'a@x.com', employee_code: 'EXISTING001' }],
  });
  const { errors } = await _validateEmployees(trx, rows);
  assert.equal(errors.filter((e) => e.code === 'EMAIL_COLLISION').length, 0);
});

test('employees: manager_employee_code not in users nor batch', async () => {
  const rows = [
    { rowNumber: 2, row: { employee_code: 'EMP001', manager_employee_code: 'GHOST' } },
  ];
  const trx = makeMockTrx({ users: [] });
  const { errors } = await _validateEmployees(trx, rows);
  const e = errors.find((x) => x.code === 'MANAGER_NOT_FOUND');
  assert.ok(e);
});

test('employees: manager_employee_code present in same batch is allowed', async () => {
  const rows = [
    { rowNumber: 2, row: { employee_code: 'EMP_MGR', manager_employee_code: null } },
    { rowNumber: 3, row: { employee_code: 'EMP001', manager_employee_code: 'EMP_MGR' } },
  ];
  const trx = makeMockTrx({ users: [] });
  const { errors } = await _validateEmployees(trx, rows);
  assert.equal(errors.filter((e) => e.code === 'MANAGER_NOT_FOUND').length, 0);
});

test('employees: manager_employee_code present only in DB is allowed', async () => {
  const rows = [
    { rowNumber: 2, row: { employee_code: 'EMP001', manager_employee_code: 'EMP_MGR' } },
  ];
  const trx = makeMockTrx({
    users: [{ employee_code: 'EMP_MGR' }],
  });
  const { errors } = await _validateEmployees(trx, rows);
  assert.equal(errors.filter((e) => e.code === 'MANAGER_NOT_FOUND').length, 0);
});

// ---------- marzam_clients ----------

test('marzam-clients: happy path returns no errors', async () => {
  const rows = [
    {
      rowNumber: 2,
      row: {
        cpadre: 'CP1',
        dataplor_id: 'DP1',
        representante_clave: 'REP01',
        supervisor_clave: 'SUP01',
        gerente_clave: 'GER01',
      },
    },
  ];
  const trx = makeMockTrx({
    pharmacies: [{ dataplor_id: 'DP1', name: 'Farma A' }],
    marzam_clients: [],
    users: [
      { employee_code: 'REP01', role: 'representante' },
      { employee_code: 'SUP01', role: 'supervisor' },
      { employee_code: 'GER01', role: 'gerente_ventas' },
    ],
  });
  const { errors, warnings } = await _validateMarzamClients(trx, rows);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
});

test('marzam-clients: dataplor_id rebind to different cpadre is an error', async () => {
  const rows = [
    { rowNumber: 2, row: { cpadre: 'CP_NEW', dataplor_id: 'DP1' } },
  ];
  const trx = makeMockTrx({
    pharmacies: [{ dataplor_id: 'DP1', name: 'Farma A' }],
    marzam_clients: [{ cpadre: 'CP_OLD', dataplor_id: 'DP1', farmacia_nombre: 'Farma A' }],
    users: [],
  });
  const { errors } = await _validateMarzamClients(trx, rows);
  assert.ok(errors.some((e) => e.code === 'DATAPLOR_REBIND'));
});

test('marzam-clients: dataplor_id same cpadre (upsert) is allowed', async () => {
  const rows = [
    { rowNumber: 2, row: { cpadre: 'CP1', dataplor_id: 'DP1' } },
  ];
  const trx = makeMockTrx({
    pharmacies: [{ dataplor_id: 'DP1', name: 'Farma A' }],
    marzam_clients: [{ cpadre: 'CP1', dataplor_id: 'DP1', farmacia_nombre: 'Farma A' }],
    users: [],
  });
  const { errors } = await _validateMarzamClients(trx, rows);
  assert.equal(errors.filter((e) => e.code === 'DATAPLOR_REBIND').length, 0);
});

test('marzam-clients: dataplor_id missing from pharmacies yields a warning', async () => {
  const rows = [
    { rowNumber: 2, row: { cpadre: 'CP1', dataplor_id: 'DP_UNKNOWN' } },
  ];
  const trx = makeMockTrx({
    pharmacies: [],
    marzam_clients: [],
    users: [],
  });
  const { errors, warnings } = await _validateMarzamClients(trx, rows);
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => w.code === 'DATAPLOR_NOT_IN_PHARMACIES'));
});

test('marzam-clients: rep_code with wrong role is an error', async () => {
  const rows = [
    { rowNumber: 2, row: { cpadre: 'CP1', representante_clave: 'SUP01' } },
  ];
  const trx = makeMockTrx({
    pharmacies: [],
    marzam_clients: [],
    users: [{ employee_code: 'SUP01', role: 'supervisor' }],
  });
  const { errors } = await _validateMarzamClients(trx, rows);
  assert.ok(errors.some((e) => e.code === 'ROLE_MISMATCH'));
});

test('marzam-clients: rep_code not found is an error', async () => {
  const rows = [
    { rowNumber: 2, row: { cpadre: 'CP1', representante_clave: 'GHOST' } },
  ];
  const trx = makeMockTrx({
    pharmacies: [],
    marzam_clients: [],
    users: [],
  });
  const { errors } = await _validateMarzamClients(trx, rows);
  assert.ok(errors.some((e) => e.code === 'USER_NOT_FOUND'));
});

// ---------- daily_sales / sales_targets ----------

test('daily-sales: cpadre exists in marzam_clients', async () => {
  const rows = [
    { rowNumber: 2, row: { cpadre: 'CP1' } },
  ];
  const trx = makeMockTrx({
    marzam_clients: [{ cpadre: 'CP1' }],
  });
  const { errors } = await _validateDailySales(trx, rows);
  assert.equal(errors.length, 0);
});

test('daily-sales: cpadre not found is an error', async () => {
  const rows = [
    { rowNumber: 2, row: { cpadre: 'CP_GHOST' } },
  ];
  const trx = makeMockTrx({ marzam_clients: [] });
  const { errors } = await _validateDailySales(trx, rows);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'CPADRE_NOT_FOUND');
});

// ---------- dispatcher ----------

test('validateCrossReferences: unknown kind returns empty', async () => {
  const result = await validateCrossReferences({}, 'unknown_kind', []);
  assert.deepEqual(result, { errors: [], warnings: [] });
});

test('validateCrossReferences: empty batch is no-op for employees', async () => {
  const trx = makeMockTrx({});
  const result = await validateCrossReferences(trx, 'employees', []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('validateCrossReferences: dispatches to marzam_clients validator', async () => {
  const rows = [
    { rowNumber: 2, row: { cpadre: 'CP1', dataplor_id: 'DP1' } },
  ];
  const trx = makeMockTrx({
    pharmacies: [{ dataplor_id: 'DP1', name: 'Farma A' }],
    marzam_clients: [{ cpadre: 'CP_OLD', dataplor_id: 'DP1', farmacia_nombre: 'Farma A' }],
    users: [],
  });
  const result = await validateCrossReferences(trx, 'marzam_clients', rows);
  assert.ok(result.errors.some((e) => e.code === 'DATAPLOR_REBIND'));
});
