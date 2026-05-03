/**
 * Header normalization + alias map for Marzam Excel/CSV files.
 *
 * Production headers are inconsistent across months (mayúsculas, tildes,
 * espacios, abreviaturas). Instead of failing on every variant we normalize
 * each header (lowercase, strip accents, collapse spaces) and then map known
 * variants to a canonical name.
 */

const { isNoiseHeader } = require('./parsers');

function normalizeHeader(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const MARZAM_CLIENTS_ALIASES = {
  // canonical id
  cpadre: 'cpadre',
  c_padre: 'cpadre',
  c_padre_marzam: 'cpadre',
  cve_padre: 'cpadre',
  clave_padre: 'cpadre',
  id_padre: 'cpadre',
  id_marzam: 'cpadre',
  id_cliente: 'cpadre',

  // pharmacy name
  farmacia: 'farmacia_nombre',
  nombre_farmacia: 'farmacia_nombre',
  nombre_comercial: 'farmacia_nombre',
  farmacia_nombre: 'farmacia_nombre',
  cliente: 'farmacia_nombre',
  nombre_cliente: 'farmacia_nombre',
  razon_social: 'farmacia_nombre',

  // location
  delegacion: 'delegacion_municipio',
  municipio: 'delegacion_municipio',
  delegacion_municipio: 'delegacion_municipio',
  mun_deleg: 'delegacion_municipio',
  alcaldia: 'delegacion_municipio',

  poblacion: 'poblacion',
  ciudad: 'poblacion',
  localidad: 'poblacion',

  // PARETO segmentation
  pareto: 'pareto',
  pareto_abc: 'pareto',
  abc: 'pareto',
  segmento: 'pareto',
  clasificacion_pareto: 'pareto',

  perfil: 'perfil',
  tipo_perfil: 'perfil',

  // flags
  unefarm: 'unefarm',
  une_farm: 'unefarm',
  unifarm: 'unefarm',

  independiente: 'is_independent',
  es_independiente: 'is_independent',
  is_independent: 'is_independent',

  contact_center: 'contact_center',
  cc: 'contact_center',
  contactcenter: 'contact_center',
  es_cc: 'contact_center',

  // counters / route
  mostradores: 'mostradores',
  num_mostradores: 'mostradores',
  no_mostradores: 'mostradores',

  cliente_visita: 'cliente_visita',
  tipo_visita: 'cliente_visita',
  visita_tipo: 'cliente_visita',

  ruta: 'ruta',
  no_ruta: 'ruta',
  num_ruta: 'ruta',
  liberacion_de_ruta: 'liberacion_de_ruta',
  liberacion_ruta: 'liberacion_de_ruta',
  fecha_liberacion: 'liberacion_de_ruta',

  // assignment labels (full name)
  representante: 'representante_label',
  rep: 'representante_label',
  rep_asignado: 'representante_label',
  representante_asignado: 'representante_label',
  nombre_rep: 'representante_label',
  visitador: 'representante_label',

  supervisor: 'supervisor_label',
  supervisor_asignado: 'supervisor_label',
  nombre_supervisor: 'supervisor_label',

  gerente: 'gerente_label',
  gerente_asignado: 'gerente_label',
  gerente_de_ventas: 'gerente_label',
  nombre_gerente: 'gerente_label',

  // assignment keys (employee_code)
  clave_rep: 'representante_clave',
  cve_rep: 'representante_clave',
  rep_clave: 'representante_clave',
  no_empleado_rep: 'representante_clave',

  clave_supervisor: 'supervisor_clave',
  cve_supervisor: 'supervisor_clave',
  supervisor_clave: 'supervisor_clave',

  clave_gerente: 'gerente_clave',
  cve_gerente: 'gerente_clave',
  gerente_clave: 'gerente_clave',

  // contact center / agent (string when no user matchable)
  clientes_cc: 'clientes_cc',
  agente: 'agente',
  agente_cc: 'agente',

  // external ids
  dataplor_id: 'dataplor_id',
  id_dataplor: 'dataplor_id',
  cve_dataplor: 'dataplor_id',
};

const DAILY_SALES_ALIASES = {
  cpadre: 'cpadre',
  c_padre: 'cpadre',
  cve_padre: 'cpadre',
  clave_padre: 'cpadre',
  id_marzam: 'cpadre',
  id_cliente: 'cpadre',

  periodo: 'period',
  mes: 'period',
  ano_mes: 'period',
  anio_mes: 'period',
  yyyymm: 'period',
  fecha: 'period',

  ano: 'year',
  anio: 'year',
  year: 'year',

  mes_num: 'month',
  num_mes: 'month',
  month: 'month',

  is_devolution: 'is_devolution',
  devolucion: 'is_devolution',
  es_devolucion: 'is_devolution',

  is_contact_center: 'is_contact_center',
  es_contact_center: 'is_contact_center',
  es_cc: 'is_contact_center',
};

const EMPLOYEES_ALIASES = {
  clave: 'employee_code',
  clave_empleado: 'employee_code',
  cve_empleado: 'employee_code',
  cve: 'employee_code',
  employee_code: 'employee_code',

  no_empleado: 'employee_number',
  numero_empleado: 'employee_number',
  num_empleado: 'employee_number',
  employee_number: 'employee_number',

  nombre: 'full_name',
  nombre_completo: 'full_name',
  full_name: 'full_name',

  email: 'email',
  correo: 'email',
  correo_electronico: 'email',
  email_corporativo: 'email',

  telefono: 'celular',
  celular: 'celular',
  telefono_celular: 'celular',
  cel: 'celular',
  telefono_particular: 'telefono_particular',
  tel_particular: 'telefono_particular',

  domicilio: 'domicilio_particular',
  domicilio_particular: 'domicilio_particular',
  direccion: 'domicilio_particular',
  direccion_particular: 'domicilio_particular',

  fecha_nacimiento: 'fecha_nacimiento',
  fecha_de_nacimiento: 'fecha_nacimiento',
  fec_nacimiento: 'fecha_nacimiento',
  cumpleanos: 'fecha_nacimiento',

  fecha_ingreso: 'fecha_ingreso',
  fecha_de_ingreso: 'fecha_ingreso',
  fec_ingreso: 'fecha_ingreso',
  antiguedad_desde: 'fecha_ingreso',

  compania: 'compania',
  empresa: 'compania',
  imei: 'imei',
  marca: 'marca_equipo',
  marca_equipo: 'marca_equipo',
  modelo: 'modelo_equipo',
  modelo_equipo: 'modelo_equipo',
  status_equipo: 'equipo_status',
  estatus_equipo: 'equipo_status',
  equipo_status: 'equipo_status',
  comentario_equipo: 'equipo_comentario',
  equipo_comentario: 'equipo_comentario',
  observaciones_equipo: 'equipo_comentario',

  rango: 'rango',
  zona: 'zona_poblaciones',
  zona_poblaciones: 'zona_poblaciones',
  zona_de_trabajo: 'zona_poblaciones',
  poblaciones: 'zona_poblaciones',

  estatus: 'estatus',
  status: 'estatus',
  situacion: 'estatus',

  rol: 'role',
  role: 'role',
  puesto: 'role',
  cargo: 'role',
  posicion: 'role',

  jefe: 'manager_employee_code',
  jefe_clave: 'manager_employee_code',
  jefe_directo: 'manager_employee_code',
  manager_clave: 'manager_employee_code',
  cve_jefe: 'manager_employee_code',

  gerencia: 'branch_code',
  sucursal: 'branch_code',
  branch_code: 'branch_code',
  cve_sucursal: 'branch_code',
  cve_gerencia: 'branch_code',
};

const SALES_TARGETS_ALIASES = {
  cpadre: 'cpadre',
  c_padre: 'cpadre',
  cve_padre: 'cpadre',
  clave_padre: 'cpadre',
  id_marzam: 'cpadre',

  periodo: 'period',
  mes: 'period',
  ano_mes: 'period',
  anio_mes: 'period',
  yyyymm: 'period',

  objetivo: 'objetivo',
  meta: 'objetivo',
  meta_venta: 'objetivo',

  presupuesto: 'presupuesto',
  budget: 'presupuesto',

  importe_para_objetivo: 'importe_para_objetivo',
  importe_objetivo: 'importe_para_objetivo',
  importe_meta: 'importe_para_objetivo',

  mostradores_para_venta: 'mostradores_para_venta',
  mostradores_objetivo: 'mostradores_para_venta',
  mostradores_con_venta: 'mostradores_con_venta',
  mostradores_vendieron: 'mostradores_con_venta',
};

/**
 * Apply alias map to a single row.
 *
 * Returns an object with:
 *   - canonical fields (e.g. cpadre, pareto, ...)
 *   - __day_columns: { 1: value, 2: value, ... } if numeric day headers found
 *   - __raw_<normalized_header>: untransformed value, only when the header
 *     is neither a known alias, a noise column, nor a day column
 */
function applyAliasMap(rawRow, aliasMap) {
  const out = {};
  const dayColumns = {};
  for (const [rawKey, value] of Object.entries(rawRow)) {
    const norm = normalizeHeader(rawKey);
    if (!norm) continue;
    const canonical = aliasMap[norm];
    if (canonical) {
      out[canonical] = value;
      continue;
    }
    // Numeric day columns 1..31 (daily_sales)
    if (/^\d{1,2}$/.test(norm)) {
      const day = Number(norm);
      if (day >= 1 && day <= 31) {
        dayColumns[day] = value;
        continue;
      }
    }
    if (/^d(?:ia)?_?\d{1,2}$/.test(norm)) {
      const day = Number(norm.replace(/^d(?:ia)?_?/, ''));
      if (day >= 1 && day <= 31) {
        dayColumns[day] = value;
        continue;
      }
    }
    if (isNoiseHeader(norm)) continue;
    out[`__raw_${norm}`] = value;
  }
  if (Object.keys(dayColumns).length) out.__day_columns = dayColumns;
  return out;
}

/**
 * Returns a summary of headers from a sample of rows: which were mapped to
 * canonical fields, which were detected as day columns, which were dropped
 * as noise, and which fell back to __raw_*. Useful for the validation CLI
 * before committing to a real run.
 */
function summarizeHeaders(rawRows, aliasMap, limit = 20) {
  const mapped = {};
  const dayCols = new Set();
  const noise = new Set();
  const unmapped = new Set();
  for (const row of rawRows.slice(0, limit)) {
    for (const rawKey of Object.keys(row)) {
      const norm = normalizeHeader(rawKey);
      if (!norm) continue;
      const canonical = aliasMap[norm];
      if (canonical) {
        if (!mapped[canonical]) mapped[canonical] = new Set();
        mapped[canonical].add(rawKey);
        continue;
      }
      if (/^\d{1,2}$/.test(norm) && Number(norm) >= 1 && Number(norm) <= 31) {
        dayCols.add(rawKey);
        continue;
      }
      if (/^d(?:ia)?_?\d{1,2}$/.test(norm)) {
        const day = Number(norm.replace(/^d(?:ia)?_?/, ''));
        if (day >= 1 && day <= 31) {
          dayCols.add(rawKey);
          continue;
        }
      }
      if (isNoiseHeader(norm)) {
        noise.add(rawKey);
        continue;
      }
      unmapped.add(rawKey);
    }
  }
  return {
    mapped: Object.fromEntries(
      Object.entries(mapped).map(([k, v]) => [k, Array.from(v)]),
    ),
    day_columns: Array.from(dayCols),
    noise: Array.from(noise),
    unmapped: Array.from(unmapped),
  };
}

module.exports = {
  normalizeHeader,
  applyAliasMap,
  summarizeHeaders,
  MARZAM_CLIENTS_ALIASES,
  DAILY_SALES_ALIASES,
  EMPLOYEES_ALIASES,
  SALES_TARGETS_ALIASES,
};
