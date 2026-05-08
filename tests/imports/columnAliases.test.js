const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeHeader,
  applyAliasMap,
  summarizeHeaders,
  MARZAM_CLIENTS_ALIASES,
  DAILY_SALES_ALIASES,
  EMPLOYEES_ALIASES,
  SALES_TARGETS_ALIASES,
} = require('../../src/modules/imports/columnAliases');

test('normalizeHeader strips accents, lowercase, replaces non-alphanum', () => {
  assert.equal(normalizeHeader('C. PADRE'), 'c_padre');
  assert.equal(normalizeHeader('  Razón Social  '), 'razon_social');
  assert.equal(normalizeHeader('GERENCIA / SUCURSAL'), 'gerencia_sucursal');
  assert.equal(normalizeHeader('ANIO_MES'), 'anio_mes');
  assert.equal(normalizeHeader('Día 15'), 'dia_15');
  assert.equal(normalizeHeader('1'), '1');
  assert.equal(normalizeHeader(''), '');
  assert.equal(normalizeHeader(null), '');
});

test('marzam_clients aliases — accent + casing variations', () => {
  const row = {
    'C. PADRE': '12345',
    'Razón Social': 'FARMACIA TEST',
    'Delegación': 'IZTAPALAPA',
    'Pareto ABC': 'A',
    'Mostradores': 3,
    'CLAVE_REP': 'EMP001',
    'Dataplor ID': 'plor-x9',
    'Total': 99999, // noise — should be dropped
  };
  const out = applyAliasMap(row, MARZAM_CLIENTS_ALIASES);
  assert.equal(out.cpadre, '12345');
  assert.equal(out.farmacia_nombre, 'FARMACIA TEST');
  assert.equal(out.delegacion_municipio, 'IZTAPALAPA');
  assert.equal(out.pareto, 'A');
  assert.equal(out.mostradores, 3);
  assert.equal(out.representante_clave, 'EMP001');
  assert.equal(out.dataplor_id, 'plor-x9');
  assert.equal(out.__raw_total, undefined, 'noise header should be dropped, not in __raw_*');
});

test('daily_sales — numeric day columns extracted, period from row', () => {
  const row = {
    'C. Padre': '999',
    Periodo: '2026-04-01',
    1: 100,
    2: 200.5,
    15: 0,
    31: null,
    Total: 9999, // noise
    Observaciones: 'foo', // noise
  };
  const out = applyAliasMap(row, DAILY_SALES_ALIASES);
  assert.equal(out.cpadre, '999');
  assert.equal(out.period, '2026-04-01');
  assert.deepEqual(out.__day_columns, { 1: 100, 2: 200.5, 15: 0, 31: null });
  assert.equal(out.__raw_total, undefined);
  assert.equal(out.__raw_observaciones, undefined);
});

test('daily_sales — DIA_05 / D_5 alternate day column patterns', () => {
  const row = {
    'C. Padre': '888',
    DIA_5: 50,
    D_15: 150,
    D25: 250,
  };
  const out = applyAliasMap(row, DAILY_SALES_ALIASES);
  assert.equal(out.__day_columns[5], 50);
  assert.equal(out.__day_columns[15], 150);
  assert.equal(out.__day_columns[25], 250);
});

test('employees — broad alias coverage', () => {
  const row = {
    Clave: 'E001',
    'No. Empleado': 12345,
    'Nombre Completo': 'JUAN PEREZ',
    Email: 'jp@m.com',
    Celular: '5544332211',
    Domicilio: 'AV X 123',
    'Fecha de Nacimiento': '1985-07-15',
    'Fecha de Ingreso': '2020-01-10',
    Compañía: 'TELCEL',
    IMEI: '12345678',
    'Marca Equipo': 'SAMSUNG',
    'Modelo Equipo': 'A52',
    'Status Equipo': 'ACTIVO',
    Rango: 'JUNIOR',
    Zona: 'ZONA NORTE',
    Estatus: 'ACTIVO',
    Puesto: 'representante',
    'Jefe Directo': 'E099',
    Sucursal: 'CDMX-01',
  };
  const out = applyAliasMap(row, EMPLOYEES_ALIASES);
  assert.equal(out.employee_code, 'E001');
  assert.equal(out.employee_number, 12345);
  assert.equal(out.full_name, 'JUAN PEREZ');
  assert.equal(out.email, 'jp@m.com');
  assert.equal(out.celular, '5544332211');
  assert.equal(out.domicilio_particular, 'AV X 123');
  assert.equal(out.fecha_nacimiento, '1985-07-15');
  assert.equal(out.fecha_ingreso, '2020-01-10');
  assert.equal(out.compania, 'TELCEL');
  assert.equal(out.imei, '12345678');
  assert.equal(out.marca_equipo, 'SAMSUNG');
  assert.equal(out.modelo_equipo, 'A52');
  assert.equal(out.equipo_status, 'ACTIVO');
  assert.equal(out.rango, 'JUNIOR');
  assert.equal(out.zona_poblaciones, 'ZONA NORTE');
  assert.equal(out.estatus, 'ACTIVO');
  assert.equal(out.role, 'representante');
  assert.equal(out.manager_employee_code, 'E099');
  assert.equal(out.branch_code, 'CDMX-01');
});

test('sales_targets — period and metric aliases', () => {
  const row = {
    'C. Padre': '777',
    'Año-Mes': '2026-03',
    Meta: '100,000.00',
    Presupuesto: '$120,000.00',
    'Importe Meta': 95000,
    'Mostradores Objetivo': 5,
    'Mostradores Vendieron': 4,
  };
  const out = applyAliasMap(row, SALES_TARGETS_ALIASES);
  assert.equal(out.cpadre, '777');
  assert.equal(out.period, '2026-03');
  assert.equal(out.objetivo, '100,000.00');
  assert.equal(out.presupuesto, '$120,000.00');
  assert.equal(out.importe_para_objetivo, 95000);
  assert.equal(out.mostradores_para_venta, 5);
  assert.equal(out.mostradores_con_venta, 4);
});

test('summarizeHeaders — categorizes mapped, day, noise, unmapped', () => {
  const rows = [
    {
      'C. PADRE': '1',
      Pareto: 'A',
      Total: 999,
      'Algun Campo Raro': 'foo',
      1: 10,
      2: 20,
    },
    {
      'C. Padre': '2',
      'Otro Campo Sin Mapeo': 'bar',
      Pareto: 'B',
    },
  ];
  const summary = summarizeHeaders(rows, MARZAM_CLIENTS_ALIASES, 50);
  assert.deepEqual(summary.mapped.cpadre.sort(), ['C. PADRE', 'C. Padre']);
  assert.equal(summary.mapped.pareto.length, 1);
  assert.ok(summary.day_columns.length >= 1, 'should detect day columns');
  assert.ok(summary.noise.includes('Total'), 'should detect Total as noise');
  assert.ok(summary.unmapped.some((u) => u.toLowerCase().includes('algun')), 'should list unmapped headers');
  assert.ok(summary.unmapped.some((u) => u.toLowerCase().includes('otro')), 'should list unmapped headers');
});
