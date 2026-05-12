'use strict';

const { normalizeRole } = require('../../constants/roles');

/**
 * Cross-reference validator for `npm run validate:import --db`.
 *
 * Runs INSIDE the same Knex transaction as `processBatch()`, so all reads are
 * consistent with what would be committed (then rolled back). Catches collisions
 * that schema validation alone misses: duplicate employee_codes within the batch,
 * email collisions against existing users, dataplor_id rebinds against
 * pharmacies/marzam_clients, manager hierarchy gaps, and role coherence on
 * assigned_rep / supervisor / gerente codes.
 *
 * Returns:
 *   { errors:   [{ row, field, code, message }],
 *     warnings: [{ row, field, code, message }] }
 *
 * Errors are blocking — `scripts/validate-import.js` brings exit to 2 on any.
 * Warnings are informational and never affect exit.
 */

const KIND_VALIDATORS = {
  marzam_clients: validateMarzamClients,
  daily_sales: validateDailySales,
  employees: validateEmployees,
  sales_targets: validateSalesTargets,
};

async function validateCrossReferences(trx, kind, normalizedRows, ctx = {}) {
  const validator = KIND_VALIDATORS[kind];
  if (!validator) return { errors: [], warnings: [] };
  return validator(trx, normalizedRows, ctx);
}

// ---------- employees ----------

async function validateEmployees(trx, normalizedRows) {
  const errors = [];
  const warnings = [];

  const codesSeen = new Map();
  for (const { rowNumber, row } of normalizedRows) {
    const code = trimOrNull(row.employee_code);
    if (!code) continue;
    if (codesSeen.has(code)) {
      errors.push({
        row: rowNumber,
        field: 'employee_code',
        code: 'DUPLICATE_IN_BATCH',
        message: `employee_code '${code}' aparece también en fila ${codesSeen.get(code)}`,
      });
    } else {
      codesSeen.set(code, rowNumber);
    }
  }

  const emails = normalizedRows
    .map(({ row }) => ({ email: trimOrNull(row.email), code: trimOrNull(row.employee_code) }))
    .filter((e) => e.email);
  if (emails.length > 0) {
    const existing = await trx('users')
      .whereIn('email', emails.map((e) => e.email))
      .select('email', 'employee_code');
    const byEmail = new Map(existing.map((u) => [u.email, u.employee_code]));
    for (const { rowNumber, row } of normalizedRows) {
      const email = trimOrNull(row.email);
      const code = trimOrNull(row.employee_code);
      if (!email) continue;
      const existingCode = byEmail.get(email);
      if (existingCode && existingCode !== code) {
        errors.push({
          row: rowNumber,
          field: 'email',
          code: 'EMAIL_COLLISION',
          message: `email '${email}' ya pertenece a employee_code '${existingCode}' (este row tiene '${code}')`,
        });
      }
    }
  }

  const managerCodes = normalizedRows
    .map(({ row }) => trimOrNull(row.manager_employee_code))
    .filter(Boolean);
  if (managerCodes.length > 0) {
    const inDb = new Set(
      (await trx('users').whereIn('employee_code', managerCodes).select('employee_code'))
        .map((u) => u.employee_code),
    );
    const inBatch = new Set([...codesSeen.keys()]);
    for (const { rowNumber, row } of normalizedRows) {
      const mgr = trimOrNull(row.manager_employee_code);
      if (!mgr) continue;
      if (!inDb.has(mgr) && !inBatch.has(mgr)) {
        errors.push({
          row: rowNumber,
          field: 'manager_employee_code',
          code: 'MANAGER_NOT_FOUND',
          message: `manager_employee_code '${mgr}' no existe en users ni en el batch`,
        });
      }
    }
  }

  return { errors, warnings };
}

// ---------- marzam_clients ----------

async function validateMarzamClients(trx, normalizedRows) {
  const errors = [];
  const warnings = [];

  const dataplorIds = normalizedRows
    .map(({ row }) => trimOrNull(row.dataplor_id))
    .filter(Boolean);
  if (dataplorIds.length > 0) {
    const existingPharma = await trx('pharmacies')
      .whereIn('dataplor_id', dataplorIds)
      .select('dataplor_id', 'name');
    const byDataplor = new Map(existingPharma.map((p) => [p.dataplor_id, p.name]));

    const claimedClients = await trx('marzam_clients')
      .whereIn('dataplor_id', dataplorIds)
      .select('cpadre', 'dataplor_id', 'farmacia_nombre');
    const byDataplorClient = new Map(claimedClients.map((c) => [c.dataplor_id, c]));

    for (const { rowNumber, row } of normalizedRows) {
      const id = trimOrNull(row.dataplor_id);
      if (!id) continue;
      if (!byDataplor.has(id)) {
        warnings.push({
          row: rowNumber,
          field: 'dataplor_id',
          code: 'DATAPLOR_NOT_IN_PHARMACIES',
          message: `dataplor_id '${id}' no existe en pharmacies (la FK marzam_clients.pharmacy_id quedará null)`,
        });
      }
      const existingClient = byDataplorClient.get(id);
      const thisCpadre = trimOrNull(row.cpadre);
      if (existingClient && existingClient.cpadre !== thisCpadre) {
        errors.push({
          row: rowNumber,
          field: 'dataplor_id',
          code: 'DATAPLOR_REBIND',
          message: `dataplor_id '${id}' ya está asignado a cpadre '${existingClient.cpadre}' (${existingClient.farmacia_nombre}); este row tiene cpadre '${thisCpadre}'`,
        });
      }
    }
  }

  const repCodes = collectCodes(normalizedRows, 'representante_clave');
  const supCodes = collectCodes(normalizedRows, 'supervisor_clave');
  const gerCodes = collectCodes(normalizedRows, 'gerente_clave');
  const allCodes = [...new Set([...repCodes, ...supCodes, ...gerCodes])];
  let usersByCode = new Map();
  if (allCodes.length > 0) {
    const users = await trx('users')
      .whereIn('employee_code', allCodes)
      .select('employee_code', 'role');
    usersByCode = new Map(users.map((u) => [u.employee_code, u]));
  }

  for (const { rowNumber, row } of normalizedRows) {
    checkRoleAssignment(rowNumber, row.representante_clave, 'representante_clave', ['representante'], usersByCode, errors);
    checkRoleAssignment(rowNumber, row.supervisor_clave, 'supervisor_clave', ['supervisor'], usersByCode, errors);
    checkRoleAssignment(rowNumber, row.gerente_clave, 'gerente_clave', ['gerente_ventas'], usersByCode, errors);
  }

  return { errors, warnings };
}

function checkRoleAssignment(rowNumber, codeRaw, field, expectedRoles, usersByCode, errors) {
  const code = trimOrNull(codeRaw);
  if (!code) return;
  const user = usersByCode.get(code);
  if (!user) {
    errors.push({
      row: rowNumber,
      field,
      code: 'USER_NOT_FOUND',
      message: `${field} '${code}' no existe en users`,
    });
    return;
  }
  const role = normalizeRole(user.role);
  if (!expectedRoles.includes(role)) {
    errors.push({
      row: rowNumber,
      field,
      code: 'ROLE_MISMATCH',
      message: `${field} '${code}' tiene rol '${user.role}' (normalizado: '${role}'); esperado uno de [${expectedRoles.join(', ')}]`,
    });
  }
}

// ---------- daily_sales ----------

async function validateDailySales(trx, normalizedRows) {
  const errors = [];
  const warnings = [];

  const cpadres = collectCodes(normalizedRows, 'cpadre');
  if (cpadres.length > 0) {
    const existing = await trx('marzam_clients')
      .whereIn('cpadre', cpadres)
      .select('cpadre');
    const inDb = new Set(existing.map((c) => c.cpadre));
    for (const { rowNumber, row } of normalizedRows) {
      const cpadre = trimOrNull(row.cpadre);
      if (!cpadre) continue;
      if (!inDb.has(cpadre)) {
        errors.push({
          row: rowNumber,
          field: 'cpadre',
          code: 'CPADRE_NOT_FOUND',
          message: `cpadre '${cpadre}' no existe en marzam_clients`,
        });
      }
    }
  }

  return { errors, warnings };
}

// ---------- sales_targets ----------

async function validateSalesTargets(trx, normalizedRows) {
  return validateDailySales(trx, normalizedRows);
}

// ---------- helpers ----------

function trimOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function collectCodes(rows, field) {
  return [...new Set(
    rows.map(({ row }) => trimOrNull(row[field])).filter(Boolean),
  )];
}

module.exports = {
  validateCrossReferences,
  _validateEmployees: validateEmployees,
  _validateMarzamClients: validateMarzamClients,
  _validateDailySales: validateDailySales,
  _validateSalesTargets: validateSalesTargets,
};
