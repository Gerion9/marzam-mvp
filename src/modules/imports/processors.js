/**
 * Per-kind row processors.
 *
 * Each processor exposes:
 *   aliasMap       — alias dictionary used by columnAliases.applyAliasMap
 *   processBatch(trx, rows, ctx) → { inserted, updated, skipped, failed, errors }
 *
 * Errors returned here go into import_jobs.errors[]. Anything that throws
 * propagates to the worker which marks the whole job 'failed'.
 */

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const {
  MARZAM_CLIENTS_ALIASES,
  DAILY_SALES_ALIASES,
  EMPLOYEES_ALIASES,
  SALES_TARGETS_ALIASES,
} = require('./columnAliases');
const { normalizeRole, ROLE_VALUES } = require('../../constants/roles');
const {
  asBool,
  asInt,
  asNumeric,
  asString,
  asDate,
} = require('./parsers');

const SALT_ROUNDS = 10;

async function resolveUserId({ trx, employeeCode, fullName }) {
  if (employeeCode) {
    const row = await trx('users').select('id').where({ employee_code: employeeCode }).first();
    if (row) return row.id;
  }
  if (fullName) {
    const row = await trx('users')
      .select('id')
      .whereRaw('LOWER(full_name) = LOWER(?)', [fullName])
      .first();
    if (row) return row.id;
  }
  return null;
}

// ---------- marzam_clients ----------

async function processMarzamClientsBatch(trx, rows, _ctx) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const { rowNumber, row } of rows) {
    const cpadre = asString(row.cpadre);
    if (!cpadre) {
      skipped += 1;
      errors.push({ row: rowNumber, reason: 'missing cpadre', raw: row });
      continue;
    }
    const pareto = asString(row.pareto)?.toUpperCase() || null;
    if (pareto && !['A', 'B', 'C'].includes(pareto)) {
      failed += 1;
      errors.push({ row: rowNumber, reason: `invalid pareto '${pareto}'`, raw: row });
      continue;
    }

    const repId = await resolveUserId({
      trx,
      employeeCode: asString(row.representante_clave),
      fullName: asString(row.representante_label),
    });
    const supervisorId = await resolveUserId({
      trx,
      employeeCode: asString(row.supervisor_clave),
      fullName: asString(row.supervisor_label),
    });
    const gerenteId = await resolveUserId({
      trx,
      employeeCode: asString(row.gerente_clave),
      fullName: asString(row.gerente_label),
    });

    const data = {
      cpadre,
      farmacia_nombre: asString(row.farmacia_nombre),
      delegacion_municipio: asString(row.delegacion_municipio),
      poblacion: asString(row.poblacion),
      pareto,
      perfil: asString(row.perfil),
      unefarm: asBool(row.unefarm, false),
      is_independent: asBool(row.is_independent, true),
      contact_center: asBool(row.contact_center, false),
      mostradores: asInt(row.mostradores),
      cliente_visita: asString(row.cliente_visita),
      ruta: asString(row.ruta),
      liberacion_de_ruta: asDate(row.liberacion_de_ruta),
      assigned_rep_id: repId,
      assigned_supervisor_id: supervisorId,
      assigned_gerente_id: gerenteId,
      clientes_cc: asString(row.clientes_cc),
      agente: asString(row.agente),
      dataplor_id: asString(row.dataplor_id),
      last_imported_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    };
    // Drop nulls so we don't blow away existing values on UPSERT.
    // Defaults (when inserting fresh) come from the table definition.
    for (const k of Object.keys(data)) {
      if (data[k] === null || data[k] === undefined) delete data[k];
    }

    try {
      const existing = await trx('marzam_clients').select('id').where({ cpadre }).first();
      if (existing) {
        await trx('marzam_clients').where({ id: existing.id }).update(data);
        updated += 1;
      } else {
        await trx('marzam_clients').insert(data);
        inserted += 1;
      }
    } catch (err) {
      failed += 1;
      errors.push({ row: rowNumber, reason: err.message, raw: row });
    }
  }

  return { inserted, updated, skipped, failed, errors };
}

// ---------- daily_sales ----------

async function ensurePartitionForDate(trx, isoDate) {
  await trx.raw('SELECT ensure_monthly_partition(?::date)', [isoDate]);
}

async function processDailySalesBatch(trx, rows, ctx) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  // ctx.meta.period (YYYY-MM-DD = 1st of month) is the period for this whole
  // file — captured at job creation time. If absent, fall back to first row.
  let defaultPeriod = ctx?.meta?.period ? asDate(ctx.meta.period) : null;

  for (const { rowNumber, row } of rows) {
    const cpadre = asString(row.cpadre);
    if (!cpadre) {
      skipped += 1;
      errors.push({ row: rowNumber, reason: 'missing cpadre', raw: row });
      continue;
    }

    const client = await trx('marzam_clients').select('id').where({ cpadre }).first();
    if (!client) {
      skipped += 1;
      errors.push({ row: rowNumber, reason: `unknown cpadre ${cpadre}`, raw: row });
      continue;
    }

    let period = asDate(row.period) || defaultPeriod;
    if (!period && row.year && row.month) {
      period = `${row.year}-${String(row.month).padStart(2, '0')}-01`;
    }
    if (!period) {
      failed += 1;
      errors.push({ row: rowNumber, reason: 'cannot resolve period', raw: row });
      continue;
    }
    if (!defaultPeriod) defaultPeriod = period;

    const isContactCenter = asBool(row.is_contact_center, false);
    const isDevolution = asBool(row.is_devolution, false);

    const dayCols = row.__day_columns || {};
    const [periodYear, periodMonth] = period.split('-').map((s) => Number(s));
    const lastDay = new Date(periodYear, periodMonth, 0).getDate();

    for (const [dayStr, value] of Object.entries(dayCols)) {
      const day = Number(dayStr);
      if (day < 1 || day > lastDay) continue;
      const amount = asNumeric(value);
      if (amount === null || amount === 0) continue;
      const saleDate = `${periodYear}-${String(periodMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      try {
        await ensurePartitionForDate(trx, saleDate);
        const result = await trx.raw(
          `INSERT INTO daily_sales (marzam_client_id, sale_date, amount, is_devolution, is_contact_center, imported_at)
             VALUES (?, ?::date, ?, ?, ?, now())
           ON CONFLICT (marzam_client_id, sale_date)
             DO UPDATE SET amount = EXCLUDED.amount,
                           is_devolution = EXCLUDED.is_devolution,
                           is_contact_center = EXCLUDED.is_contact_center,
                           imported_at = EXCLUDED.imported_at
           RETURNING (xmax = 0) AS inserted`,
          [client.id, saleDate, amount, isDevolution, isContactCenter],
        );
        const wasInsert = result?.rows?.[0]?.inserted;
        if (wasInsert) inserted += 1;
        else updated += 1;
      } catch (err) {
        failed += 1;
        errors.push({ row: rowNumber, reason: `${saleDate}: ${err.message}`, raw: row });
      }
    }
  }

  return { inserted, updated, skipped, failed, errors };
}

// ---------- employees ----------

async function processEmployeesBatch(trx, rows, _ctx) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const { rowNumber, row } of rows) {
    const employeeCode = asString(row.employee_code);
    if (!employeeCode) {
      skipped += 1;
      errors.push({ row: rowNumber, reason: 'missing employee_code', raw: row });
      continue;
    }

    const fullName = asString(row.full_name);
    const email = asString(row.email);
    const requestedRole = asString(row.role);
    const role = requestedRole ? normalizeRole(requestedRole) : null;
    if (role && !ROLE_VALUES.includes(role)) {
      failed += 1;
      errors.push({ row: rowNumber, reason: `unknown role '${requestedRole}'`, raw: row });
      continue;
    }

    const branchCode = asString(row.branch_code);
    let branchId = null;
    if (branchCode) {
      const branch = await trx('branches').select('id').where({ code: branchCode }).first();
      branchId = branch?.id || null;
    }

    const managerCode = asString(row.manager_employee_code);
    let managerId = null;
    if (managerCode) {
      const mgr = await trx('users').select('id').where({ employee_code: managerCode }).first();
      managerId = mgr?.id || null;
    }

    try {
      let user = await trx('users').select('*').where({ employee_code: employeeCode }).first();
      let wasInsert = false;
      if (!user && email) {
        user = await trx('users').select('*').where({ email }).first();
      }

      if (!user) {
        const newId = uuidv4();
        const placeholderEmail = email || `${employeeCode.toLowerCase()}@marzam.local`;
        const placeholderPwd = await bcrypt.hash(uuidv4(), SALT_ROUNDS);
        await trx('users').insert({
          id: newId,
          email: placeholderEmail,
          password_hash: placeholderPwd,
          full_name: fullName || employeeCode,
          role: role || 'representante',
          employee_code: employeeCode,
          employee_number: asString(row.employee_number),
          must_change_password: true,
          manager_id: managerId,
          branch_id: branchId,
        });
        user = await trx('users').select('*').where({ id: newId }).first();
        wasInsert = true;
      } else {
        const patch = { updated_at: trx.fn.now() };
        if (fullName) patch.full_name = fullName;
        if (email && email !== user.email) patch.email = email;
        if (role) patch.role = role;
        patch.employee_code = employeeCode;
        if (asString(row.employee_number)) patch.employee_number = asString(row.employee_number);
        if (managerCode !== null) patch.manager_id = managerId;
        if (branchCode !== null) patch.branch_id = branchId;
        await trx('users').where({ id: user.id }).update(patch);
      }

      // Upsert employee_profiles
      const profilePatch = {
        user_id: user.id,
        domicilio_particular: asString(row.domicilio_particular),
        telefono_particular: asString(row.telefono_particular),
        celular: asString(row.celular),
        fecha_nacimiento: asDate(row.fecha_nacimiento),
        fecha_ingreso: asDate(row.fecha_ingreso),
        compania: asString(row.compania),
        imei: asString(row.imei),
        marca_equipo: asString(row.marca_equipo),
        modelo_equipo: asString(row.modelo_equipo),
        equipo_status: asString(row.equipo_status),
        equipo_comentario: asString(row.equipo_comentario),
        zona_poblaciones: asString(row.zona_poblaciones),
        rango: asString(row.rango),
        estatus: asString(row.estatus),
        updated_at: trx.fn.now(),
      };
      const existingProfile = await trx('employee_profiles').select('user_id').where({ user_id: user.id }).first();
      if (existingProfile) {
        await trx('employee_profiles').where({ user_id: user.id }).update(profilePatch);
      } else {
        await trx('employee_profiles').insert(profilePatch);
      }

      if (wasInsert) inserted += 1;
      else updated += 1;
    } catch (err) {
      failed += 1;
      errors.push({ row: rowNumber, reason: err.message, raw: row });
    }
  }

  return { inserted, updated, skipped, failed, errors };
}

// ---------- sales_targets ----------

async function processSalesTargetsBatch(trx, rows, ctx) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  const defaultPeriod = ctx?.meta?.period ? asDate(ctx.meta.period) : null;

  for (const { rowNumber, row } of rows) {
    const cpadre = asString(row.cpadre);
    if (!cpadre) {
      skipped += 1;
      errors.push({ row: rowNumber, reason: 'missing cpadre', raw: row });
      continue;
    }
    const client = await trx('marzam_clients').select('id').where({ cpadre }).first();
    if (!client) {
      skipped += 1;
      errors.push({ row: rowNumber, reason: `unknown cpadre ${cpadre}`, raw: row });
      continue;
    }

    const period = asDate(row.period) || defaultPeriod;
    if (!period) {
      failed += 1;
      errors.push({ row: rowNumber, reason: 'cannot resolve period', raw: row });
      continue;
    }

    const data = {
      marzam_client_id: client.id,
      period,
      objetivo: asNumeric(row.objetivo) ?? 0,
      presupuesto: asNumeric(row.presupuesto) ?? 0,
      importe_para_objetivo: asNumeric(row.importe_para_objetivo) ?? 0,
      mostradores_para_venta: asInt(row.mostradores_para_venta),
      mostradores_con_venta: asInt(row.mostradores_con_venta),
      updated_at: trx.fn.now(),
    };

    try {
      const existing = await trx('sales_targets')
        .where({ marzam_client_id: client.id, period })
        .first();
      if (existing) {
        await trx('sales_targets').where({ marzam_client_id: client.id, period }).update(data);
        updated += 1;
      } else {
        await trx('sales_targets').insert(data);
        inserted += 1;
      }
    } catch (err) {
      failed += 1;
      errors.push({ row: rowNumber, reason: err.message, raw: row });
    }
  }

  return { inserted, updated, skipped, failed, errors };
}

const PROCESSORS = {
  marzam_clients: { aliasMap: MARZAM_CLIENTS_ALIASES, processBatch: processMarzamClientsBatch },
  daily_sales: { aliasMap: DAILY_SALES_ALIASES, processBatch: processDailySalesBatch },
  employees: { aliasMap: EMPLOYEES_ALIASES, processBatch: processEmployeesBatch },
  sales_targets: { aliasMap: SALES_TARGETS_ALIASES, processBatch: processSalesTargetsBatch },
};

module.exports = {
  PROCESSORS,
};
