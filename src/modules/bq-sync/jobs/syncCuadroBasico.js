/**
 * Sync `int_marzam_cuadro_basico` → users + employee_profiles.
 *
 * Source layout (verified 2026-04-29 against staging.cuadro_basico):
 *   - 175 rows: 1 GERENTE row, 17 SUPERVISOR rows, 157 REPRESENTANTE rows.
 *   - **No email column** — emails are synthesized via convention:
 *       <clave_lower>@marzam.mx
 *     (decision: user/2026-04-29).
 *   - **All 6 gerente rows share `clave='GERENTE'`** — that breaks UPSERT
 *     by employee_code. We synthesize a stable, unique code from the name:
 *       GER_<APPELLIDO_PRIMARY> (best-effort, see synthGerenteCode()).
 *   - **clave is hierarchical**: 2 chars = gerencia (UE), 3 chars = supervisor
 *     (UEA), 5 chars = rep (UEA06). The supervisor and gerencia codes do NOT
 *     appear as their own rows in cuadro_basico — they are created later in
 *     the hierarchy job that crosses cuadro_basico ↔ detalle_mostrador.
 *
 * What this job does NOT do:
 *   - Resolve `users.manager_id` (the chain rep→supervisor→gerencia is built
 *     by syncHierarchy, which reads detalle_mostrador to extract distinct
 *     triplets and stitch the FK graph).
 *   - Touch `branches` (also a hierarchy concern).
 *
 * Email handling rules — guarantee that running this job repeatedly never
 * breaks the UNIQUE constraint on `users.email`:
 *
 *   1. Synthesized email = `<clave_lower>@marzam.mx`.
 *   2. If another user already owns that email, emit warning `email_conflict`
 *      and use a backup placeholder `<clave_lower>@marzam.local`.
 *   3. We never read an email FROM the source — there is none.
 *
 * Audit: every soft inconsistency is logged into `bq_sync_warnings`.
 */

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../../../config/database');
const { ROLES, ROLE_VALUES, normalizeRole } = require('../../../constants/roles');
const {
  BQ_TABLES,
  fetchAll,
  buildKeyMap,
  pickFirst,
  asString,
  asDate,
  auditCandidateColumns,
  evaluateJobHealth,
} = require('../bqHelpers');
const { emitWarning } = require('../warnings');

const SALT_ROUNDS = 10;
const JOB_NAME = 'cuadro_basico';
const PRIMARY_EMAIL_DOMAIN = '@marzam.mx';
const PLACEHOLDER_EMAIL_DOMAIN = '@marzam.local';

const COL_CANDIDATES = {
  employee_code: ['clave', 'clave_empleado', 'employee_code', 'cve_empleado'],
  employee_number: ['no_empleado', 'numero_empleado', 'employee_number'],
  full_name: ['nombre_del_empleado', 'nombre', 'nombre_completo', 'full_name', 'colaborador'],
  // No email column in the source; we synthesize.
  email: ['email', 'correo', 'correo_electronico', 'email_corporativo'],
  // `rango` is the role label (GERENTE | SUPERVISOR | REPRESENTANTE).
  role: ['rango', 'puesto', 'rol', 'role', 'cargo'],
  poblacion: ['zona_poblaciones', 'poblacion', 'poblaciones', 'plaza'],
  zona: ['zonas', 'zona', 'territorio'],
  imei: ['imei'],
  marca: ['marca', 'marca_equipo'],
  modelo: ['modelo', 'modelo_equipo'],
  fecha_ingreso: ['fecha_ingreso', 'fecha_de_ingreso', 'antiguedad_fecha'],
  fecha_nacimiento: ['fecha_nacimiento', 'fecha_de_nacimiento'],
  domicilio: ['domicilio_particular', 'domicilio', 'direccion'],
  telefono: ['telefono_particular', 'telefono'],
  celular: ['celular', 'movil', 'telefono_celular'],
  estatus: ['estatus', 'status'],
};

function __getCandidatesForInspector() { return COL_CANDIDATES; }

/**
 * Strip diacritics and non-alphanumerics, returning a stable token.
 * "GARDUÑO PÉREZ LETICIA" → "GARDUNO_PEREZ_LETICIA"
 */
function tokenize(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Generate a stable, unique employee_code for a GERENTE row whose source
 * clave is the literal word "GERENTE" (the data team duplicates it).
 *
 * Uses the first surname + first letter of the second name to keep it short
 * yet unambiguous for the small set of managers (~6).
 */
function synthGerenteCode(fullName) {
  const tokens = tokenize(fullName).split('_').filter(Boolean);
  if (tokens.length === 0) return `GER_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  // Heuristic: first 1-2 tokens (apellido paterno + materno or first name)
  const head = tokens.slice(0, 2).join('_');
  return `GER_${head}`.slice(0, 32);
}

function isPlaceholderEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith(PLACEHOLDER_EMAIL_DOMAIN);
}

function synthesizeEmail(employeeCode) {
  return `${String(employeeCode).toLowerCase()}${PRIMARY_EMAIL_DOMAIN}`;
}

function placeholderEmail(employeeCode) {
  return `${String(employeeCode).toLowerCase()}${PLACEHOLDER_EMAIL_DOMAIN}`;
}

/**
 * Map cuadro_basico's `rango` (Spanish) to our role enum.
 * Returns null when the value is unknown — caller decides fallback.
 */
function rangoToRole(rango) {
  if (!rango) return null;
  const t = tokenize(rango).toLowerCase();
  if (t.includes('gerente')) return ROLES.GERENTE_VENTAS;
  if (t.includes('supervisor')) return ROLES.SUPERVISOR;
  if (t.includes('representante') || t.includes('agente') || t.includes('vendedor')) {
    return ROLES.REPRESENTANTE;
  }
  if (t.includes('director')) return ROLES.DIRECTOR_SUCURSAL;
  return normalizeRole(t);
}

/**
 * Pick the canonical employee_code:
 *   - GERENTE rows get a synthesized code (their source clave is the literal "GERENTE").
 *   - All other roles use the source clave as-is.
 */
function canonicalEmployeeCode(rawCode, role, fullName) {
  if (rawCode && rawCode.toUpperCase() === 'GERENTE' && role === ROLES.GERENTE_VENTAS) {
    return synthGerenteCode(fullName);
  }
  return rawCode;
}

async function findExistingUser(trx, employeeCode) {
  return trx('users').where({ employee_code: employeeCode }).first();
}

async function resolveEmail(trx, employeeCode, currentEmail = null) {
  const desired = synthesizeEmail(employeeCode);
  if (currentEmail && currentEmail === desired) return null; // no change
  const conflict = await trx('users')
    .select('id', 'employee_code')
    .where({ email: desired })
    .andWhereNot({ employee_code: employeeCode })
    .first();
  if (conflict) {
    await emitWarning(trx, {
      jobName: JOB_NAME,
      code: 'email_conflict',
      subject: employeeCode,
      detail: {
        attempted_email: desired,
        owned_by_user_id: conflict.id,
        owned_by_employee_code: conflict.employee_code,
      },
      severity: 'warn',
    });
    return placeholderEmail(employeeCode);
  }
  return desired;
}

async function run({ limit = null } = {}) {
  const startedAt = Date.now();
  const rows = await fetchAll(BQ_TABLES.CUADRO_BASICO, { limit });
  if (!rows.length) {
    return {
      name: JOB_NAME, rows: 0, inserted: 0, updated: 0, skipped: 0, warnings: 0,
      duration_ms: Date.now() - startedAt,
    };
  }

  const keyMap = buildKeyMap(rows[0]);

  // Schema drift detection: required logical fields must map to at least one
  // present source column. If any required is missing, abort early — running
  // with a missing employee_code or full_name produces nonsense rows.
  const REQUIRED_LOGICAL_FIELDS = ['employee_code', 'full_name', 'role'];
  const colAudit = auditCandidateColumns(JOB_NAME, keyMap, COL_CANDIDATES, REQUIRED_LOGICAL_FIELDS);
  if (colAudit.missing_required.length > 0) {
    return {
      name: JOB_NAME,
      status: 'failed',
      failure: 'schema_drift_missing_required',
      missing_required: colAudit.missing_required,
      missing_optional: colAudit.missing.filter((n) => !REQUIRED_LOGICAL_FIELDS.includes(n)),
      rows: rows.length,
      inserted: 0, updated: 0, skipped: rows.length, warnings: 0,
      duration_ms: Date.now() - startedAt,
    };
  }

  const stats = {
    rows: rows.length, inserted: 0, updated: 0, skipped: 0, warnings: 0,
    role_unknown: 0, gerente_synthesized: 0, duplicate_employee_codes: 0, email_conflicts: 0,
    missing_optional_columns: colAudit.missing,
  };
  const seenCodesInBatch = new Set();

  for (const raw of rows) {
    const rawCode = asString(pickFirst(raw, COL_CANDIDATES.employee_code, keyMap));
    if (!rawCode) {
      stats.skipped += 1;
      continue;
    }

    const fullName = asString(pickFirst(raw, COL_CANDIDATES.full_name, keyMap)) || rawCode;
    const rangoRaw = asString(pickFirst(raw, COL_CANDIDATES.role, keyMap));
    const role = rangoToRole(rangoRaw);
    const safeRole = role && ROLE_VALUES.includes(role) ? role : ROLES.REPRESENTANTE;
    if (!role || !ROLE_VALUES.includes(role)) {
      stats.role_unknown += 1;
      stats.warnings += 1;
    }

    const employeeCode = canonicalEmployeeCode(rawCode, safeRole, fullName);
    if (employeeCode !== rawCode) stats.gerente_synthesized += 1;

    if (seenCodesInBatch.has(employeeCode)) {
      stats.duplicate_employee_codes += 1;
      stats.warnings += 1;
      await emitWarning(db, {
        jobName: JOB_NAME,
        code: 'duplicate_employee',
        subject: employeeCode,
        detail: {
          source_clave: rawCode, full_name: fullName, role: safeRole,
          note: 'Same canonical employee_code generated for two source rows. Investigate naming heuristic.',
        },
        severity: 'warn',
      });
    }
    seenCodesInBatch.add(employeeCode);

    const profile = {
      domicilio_particular: asString(pickFirst(raw, COL_CANDIDATES.domicilio, keyMap)),
      telefono_particular: asString(pickFirst(raw, COL_CANDIDATES.telefono, keyMap)),
      celular: asString(pickFirst(raw, COL_CANDIDATES.celular, keyMap)),
      fecha_nacimiento: asDate(pickFirst(raw, COL_CANDIDATES.fecha_nacimiento, keyMap)),
      fecha_ingreso: asDate(pickFirst(raw, COL_CANDIDATES.fecha_ingreso, keyMap)),
      imei: asString(pickFirst(raw, COL_CANDIDATES.imei, keyMap)),
      marca_equipo: asString(pickFirst(raw, COL_CANDIDATES.marca, keyMap)),
      modelo_equipo: asString(pickFirst(raw, COL_CANDIDATES.modelo, keyMap)),
      zona_poblaciones: asString(pickFirst(raw, COL_CANDIDATES.poblacion, keyMap)),
      rango: rangoRaw,
      estatus: asString(pickFirst(raw, COL_CANDIDATES.estatus, keyMap)),
    };

    try {
      await db.transaction(async (trx) => {
        const existing = await findExistingUser(trx, employeeCode);
        let userId;
        let isInsert = false;

        if (!existing) {
          userId = uuidv4();
          const finalEmail = (await resolveEmail(trx, employeeCode)) || synthesizeEmail(employeeCode);
          if (isPlaceholderEmail(finalEmail)) stats.email_conflicts += 1;
          const placeholderPwd = await bcrypt.hash(uuidv4(), SALT_ROUNDS);
          await trx('users').insert({
            id: userId,
            email: finalEmail,
            password_hash: placeholderPwd,
            full_name: fullName,
            role: safeRole,
            employee_code: employeeCode,
            employee_number: asString(pickFirst(raw, COL_CANDIDATES.employee_number, keyMap)),
            must_change_password: true,
          });
          isInsert = true;
        } else {
          userId = existing.id;
          const patch = { updated_at: trx.fn.now(), full_name: fullName };
          const newEmail = await resolveEmail(trx, employeeCode, existing.email);
          if (newEmail) patch.email = newEmail;
          if (safeRole && safeRole !== existing.role) patch.role = safeRole;
          const empNumber = asString(pickFirst(raw, COL_CANDIDATES.employee_number, keyMap));
          if (empNumber) patch.employee_number = empNumber;
          await trx('users').where({ id: userId }).update(patch);
        }

        const existingProfile = await trx('employee_profiles').where({ user_id: userId }).first();
        // Don't blow away an existing profile field with null
        const profilePatch = { ...profile, user_id: userId, updated_at: trx.fn.now() };
        for (const k of Object.keys(profilePatch)) {
          if (profilePatch[k] === null && k !== 'user_id') delete profilePatch[k];
        }
        if (existingProfile) {
          if (Object.keys(profilePatch).length > 1) {
            await trx('employee_profiles').where({ user_id: userId }).update(profilePatch);
          }
        } else {
          await trx('employee_profiles').insert({ user_id: userId, ...profilePatch });
        }

        if (isInsert) stats.inserted += 1;
        else stats.updated += 1;
      });
    } catch (e) {
      stats.skipped += 1;
      stats.warnings += 1;
      // eslint-disable-next-line no-console
      console.warn(`[bq-sync:${JOB_NAME}] employee ${employeeCode}: ${e.message}`);
      try {
        await emitWarning(db, {
          jobName: JOB_NAME,
          code: 'row_failed',
          subject: employeeCode,
          detail: { reason: e.message, source_clave: rawCode, role: safeRole },
          severity: 'error',
        });
      } catch {
        // never let warning emit crash the run
      }
    }
  }

  const health = evaluateJobHealth(stats);
  return {
    name: JOB_NAME,
    status: health.status,
    ...(health.reason ? { failure: health.reason } : {}),
    ...stats,
    duration_ms: Date.now() - startedAt,
  };
}

module.exports = {
  run,
  JOB_NAME,
  __getCandidatesForInspector,
  // exported for testing & for syncHierarchy
  rangoToRole,
  synthGerenteCode,
  tokenize,
  synthesizeEmail,
  PRIMARY_EMAIL_DOMAIN,
};
