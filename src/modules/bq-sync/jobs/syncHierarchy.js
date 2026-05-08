/**
 * Sync hierarchy — derives the rep ↔ supervisor ↔ gerencia tree by reading
 * distinct triplets from `staging.stg_marzam_detalle_mostrador` and stitching
 * the FK graph back into `users` and `branches`.
 *
 * MUST run AFTER syncCuadroBasico (which inserts the leaf reps with their
 * 5-char employee_code) and ideally after syncDetalleMostrador (so that the
 * hierarchy is consistent with the latest snapshot).
 *
 * Why a separate job?
 *   - cuadro_basico does NOT contain supervisor/gerencia rows with proper
 *     codes (verified 2026-04-29). Supervisores tienen 3 chars (UEA), las
 *     gerencias 2 chars (UE), but those rows simply don't exist in cuadro_basico.
 *   - detalle_mostrador is the ground truth: every client carries the full
 *     (gerencia, gerente_nombre, supervisor, supervisor_nombre, agente=rep)
 *     for its assigned territory.
 *
 * What we do here:
 *   1. SELECT DISTINCT(gerencia, gerente, supervisor, supervisor_nombre,
 *                       agente) FROM detalle_mostrador.
 *   2. For each unique gerencia code:
 *        - UPSERT branch (code=gerencia, name=gerente_nombre or gerencia code).
 *        - Locate or create the gerente user (matched by `nombre_del_empleado`
 *          for rows with rango=GERENTE in cuadro_basico, since those have
 *          synthesized employee_codes). Set their branch_id, role.
 *   3. For each unique supervisor code in that gerencia:
 *        - UPSERT user with employee_code=supervisor (e.g. UEA), role=supervisor,
 *          full_name=supervisor_nombre, manager_id=gerente.id, branch_id.
 *        - Synthesize email <code>@marzam.mx as usual.
 *   4. For each rep:
 *        - Find by employee_code (5-char code).
 *        - Set manager_id=supervisor.id, branch_id=branch.id.
 *
 * Idempotent: re-runs are no-ops when nothing changed.
 */

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../../../config/database');
const { ROLES } = require('../../../constants/roles');
const { getMarzamSourceDb } = require('../../../integrations/marzamSource/client');
const { BQ_TABLES, splitTable, asString } = require('../bqHelpers');
const { synthesizeEmail, tokenize } = require('./syncCuadroBasico');
const { emitWarning } = require('../warnings');

const JOB_NAME = 'hierarchy';
const SALT_ROUNDS = 10;

/**
 * Find a manager user in cuadro_basico-derived rows by matching
 * `nombre_del_empleado` (because their employee_code was synthesized).
 *
 * Returns the `users` row or null.
 */
async function findGerenteUserByName(trx, gerenteName) {
  if (!gerenteName) return null;
  const tok = tokenize(gerenteName);
  // Match by exact name first, then by token-normalized name
  const exact = await trx('users').where({ full_name: gerenteName }).first();
  if (exact) return exact;
  // Token match: any users.full_name that normalizes to the same token sequence
  const candidates = await trx('users')
    .where('role', ROLES.GERENTE_VENTAS)
    .select('id', 'full_name', 'employee_code', 'email', 'role', 'branch_id');
  const target = tok;
  for (const c of candidates) {
    if (tokenize(c.full_name) === target) return c;
  }
  return null;
}

async function ensureBranch(trx, code, name) {
  if (!code) return null;
  const existing = await trx('branches').where({ code }).first();
  if (existing) {
    if (name && existing.name !== name) {
      await trx('branches').where({ id: existing.id }).update({ name });
    }
    return existing.id;
  }
  const [row] = await trx('branches')
    .insert({ code, name: name || code })
    .returning(['id']);
  return row.id;
}

async function ensureSupervisor(trx, supervisorCode, supervisorName, branchId, gerenteUserId) {
  if (!supervisorCode) return null;
  let user = await trx('users').where({ employee_code: supervisorCode }).first();
  if (!user) {
    const id = uuidv4();
    const placeholderPwd = await bcrypt.hash(uuidv4(), SALT_ROUNDS);
    const email = synthesizeEmail(supervisorCode);
    // Avoid email collision
    const conflict = await trx('users').where({ email }).first();
    const finalEmail = conflict ? `${supervisorCode.toLowerCase()}@marzam.local` : email;
    if (conflict) {
      await emitWarning(trx, {
        jobName: JOB_NAME,
        code: 'email_conflict',
        subject: supervisorCode,
        detail: { attempted_email: email, owned_by_user_id: conflict.id },
        severity: 'warn',
      });
    }
    await trx('users').insert({
      id,
      email: finalEmail,
      password_hash: placeholderPwd,
      full_name: supervisorName || supervisorCode,
      role: ROLES.SUPERVISOR,
      employee_code: supervisorCode,
      branch_id: branchId,
      manager_id: gerenteUserId,
      must_change_password: true,
    });
    return { id, isNew: true };
  }
  // Update with current snapshot (don't overwrite a real name with VACANTE etc.)
  const patch = { updated_at: trx.fn.now() };
  if (supervisorName && supervisorName !== 'VACANTE' && user.full_name !== supervisorName) {
    patch.full_name = supervisorName;
  }
  if (user.role !== ROLES.SUPERVISOR) patch.role = ROLES.SUPERVISOR;
  if (branchId && user.branch_id !== branchId) patch.branch_id = branchId;
  if (gerenteUserId && user.manager_id !== gerenteUserId) patch.manager_id = gerenteUserId;
  if (Object.keys(patch).length > 1) {
    await trx('users').where({ id: user.id }).update(patch);
  }
  return { id: user.id, isNew: false };
}

async function attachRep(trx, repCode, repName, supervisorUserId, branchId) {
  if (!repCode) return { found: false };
  const user = await trx('users').where({ employee_code: repCode }).first();
  if (!user) {
    return { found: false };
  }
  const patch = { updated_at: trx.fn.now() };
  if (supervisorUserId && user.manager_id !== supervisorUserId) patch.manager_id = supervisorUserId;
  if (branchId && user.branch_id !== branchId) patch.branch_id = branchId;
  if (repName && repName !== 'VACANTE' && user.full_name !== repName) patch.full_name = repName;
  if (Object.keys(patch).length > 1) {
    await trx('users').where({ id: user.id }).update(patch);
  }
  return { found: true, id: user.id };
}

async function run({ limit = null } = {}) {
  const startedAt = Date.now();
  const stats = {
    rows: 0,
    branches_inserted: 0, branches_updated: 0,
    gerente_linked: 0, gerente_missing: 0,
    supervisors_inserted: 0, supervisors_updated: 0,
    reps_linked: 0, reps_missing: 0,
    warnings: 0,
  };

  // 1. Pull distinct hierarchy rows from detalle_mostrador
  const sourceDb = getMarzamSourceDb();
  const [schema, table] = splitTable(BQ_TABLES.DETALLE_MOSTRADOR);
  const builder = sourceDb
    .withSchema(schema)
    .from(table)
    .distinct('gerencia', 'gerente', 'supervisor', 'supervisor_nombre', 'agente', 'representante')
    .whereNotNull('gerencia');
  if (limit) builder.limit(Math.trunc(Number(limit)));
  const rows = await builder;
  stats.rows = rows.length;
  if (!rows.length) {
    return { name: JOB_NAME, ...stats, duration_ms: Date.now() - startedAt };
  }

  // 2. Group by gerencia
  const byGerencia = new Map();
  for (const r of rows) {
    const g = asString(r.gerencia);
    if (!g) continue;
    if (!byGerencia.has(g)) byGerencia.set(g, { gerente: null, supervisors: new Map() });
    const bucket = byGerencia.get(g);
    if (!bucket.gerente && r.gerente && r.gerente !== 'VACANTE') bucket.gerente = asString(r.gerente);
    const sup = asString(r.supervisor);
    if (!sup) continue;
    if (!bucket.supervisors.has(sup)) bucket.supervisors.set(sup, { name: null, reps: [] });
    const supBucket = bucket.supervisors.get(sup);
    if (!supBucket.name && r.supervisor_nombre && r.supervisor_nombre !== 'VACANTE') {
      supBucket.name = asString(r.supervisor_nombre);
    }
    if (r.agente) {
      supBucket.reps.push({ code: asString(r.agente), name: asString(r.representante) });
    }
  }

  // 3. For each gerencia, walk the tree
  for (const [gerenciaCode, bucket] of byGerencia) {
    try {
      await db.transaction(async (trx) => {
        const branchName = bucket.gerente || gerenciaCode;
        const existingBranch = await trx('branches').where({ code: gerenciaCode }).first();
        const branchId = await ensureBranch(trx, gerenciaCode, branchName);
        if (existingBranch) stats.branches_updated += 1;
        else stats.branches_inserted += 1;

        // Locate gerente user (synthesized employee_code, name match)
        let gerenteUserId = null;
        if (bucket.gerente) {
          const gerenteUser = await findGerenteUserByName(trx, bucket.gerente);
          if (gerenteUser) {
            const patch = { updated_at: trx.fn.now() };
            if (gerenteUser.branch_id !== branchId) patch.branch_id = branchId;
            if (gerenteUser.role !== ROLES.GERENTE_VENTAS) patch.role = ROLES.GERENTE_VENTAS;
            if (Object.keys(patch).length > 1) {
              await trx('users').where({ id: gerenteUser.id }).update(patch);
            }
            gerenteUserId = gerenteUser.id;
            stats.gerente_linked += 1;
          } else {
            stats.gerente_missing += 1;
            stats.warnings += 1;
            await emitWarning(trx, {
              jobName: JOB_NAME,
              code: 'gerente_unmatched',
              subject: gerenciaCode,
              detail: { gerente_name: bucket.gerente, note: 'Could not find a user with role=gerente_ventas matching this name' },
              severity: 'warn',
            });
          }
        }

        // Walk supervisors in this gerencia
        for (const [supCode, supBucket] of bucket.supervisors) {
          const supResult = await ensureSupervisor(trx, supCode, supBucket.name, branchId, gerenteUserId);
          if (supResult.isNew) stats.supervisors_inserted += 1;
          else stats.supervisors_updated += 1;

          // Walk reps under this supervisor
          for (const rep of supBucket.reps) {
            const out = await attachRep(trx, rep.code, rep.name, supResult.id, branchId);
            if (out.found) stats.reps_linked += 1;
            else {
              stats.reps_missing += 1;
              stats.warnings += 1;
              await emitWarning(trx, {
                jobName: JOB_NAME,
                code: 'rep_missing',
                subject: rep.code,
                detail: {
                  rep_name: rep.name,
                  supervisor_code: supCode,
                  gerencia_code: gerenciaCode,
                  note: 'Rep present in detalle_mostrador but not in cuadro_basico (users)',
                },
                severity: 'info',
              });
            }
          }
        }
      });
    } catch (e) {
      stats.warnings += 1;
      // eslint-disable-next-line no-console
      console.warn(`[bq-sync:${JOB_NAME}] gerencia ${gerenciaCode}: ${e.message}`);
      try {
        await emitWarning(db, {
          jobName: JOB_NAME,
          code: 'gerencia_failed',
          subject: gerenciaCode,
          detail: { reason: e.message },
          severity: 'error',
        });
      } catch {
        // swallow
      }
    }
  }

  return { name: JOB_NAME, ...stats, duration_ms: Date.now() - startedAt };
}

module.exports = { run, JOB_NAME };
