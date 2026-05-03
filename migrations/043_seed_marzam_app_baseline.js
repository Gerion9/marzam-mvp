/**
 * Baseline seed for the marzam_app schema.
 *
 * After all DDL migrations have run on a fresh database, this migration
 * populates:
 *   1) The Sucursal Ecatepec branch (the only branch supported by the MVP).
 *   2) The four virtual users defined in `AUTH_DIRECTORY_JSON` (director,
 *      gerente, supervisor, representante) with deterministic UUIDs derived
 *      via uuidv5 from their virtual id (matches what `accessDirectory.js`
 *      computes at runtime, so a JWT issued in virtual mode resolves to the
 *      same row in the database).
 *
 * Why a migration and not a Knex seed: knex seeds aren't tracked in
 * `knex_migrations`, which makes them brittle to re-run in a CI/CD pipeline.
 * This is one-shot baseline data with deterministic ids, so the migration
 * itself is idempotent (uses ON CONFLICT … DO UPDATE).
 *
 * The directory chain mapping (manager_code → manager) follows the Marzam
 * `cuadro_basico` convention documented in `src/modules/team/team.service.js`:
 *   - rep.manager_code = LEFT(supervisor.employee_code, 3)
 *   - supervisor.manager_code = supervisor.gerencia_code = gerente.employee_code
 *   - gerente.manager_code = director.employee_code (sucursal code)
 */

const { v5: uuidv5 } = require('uuid');
const bcrypt = require('bcryptjs');

// Same namespace the runtime accessDirectory uses, so JWT subjects line up
// with rows in users.id without any extra mapping.
const DEVICE_USER_NAMESPACE = '74e8d182-c5ba-4f5c-bffe-7549315401a3';
const BRANCH_NAMESPACE = '5e3b1e0f-2b1e-4b1e-9b1e-2b1e4b1e9b1e';

const ECATEPEC_BRANCH_ID = uuidv5('branch-ecatepec', BRANCH_NAMESPACE);

function virtualToUuid(virtualId) {
  return uuidv5(String(virtualId), DEVICE_USER_NAMESPACE);
}

function findManagerVirtualId(user, allUsers) {
  if (!user.manager_code) return null;
  // 1) Exact employee_code match (covers gerente.manager_code = director EC)
  const exact = allUsers.find((u) => u.employee_code === user.manager_code);
  if (exact) return exact.id;
  // 2) Supervisor lookup via 3-letter prefix (rep.manager_code = 'UEA' →
  //    supervisor with employee_code 'UEA00').
  const sup = allUsers.find((u) => u.role === 'supervisor'
    && String(u.employee_code || '').startsWith(String(user.manager_code)));
  if (sup) return sup.id;
  return null;
}

exports.up = async function up(knex) {
  // ---------------------------------------------------------------------------
  // 1) Branch
  // ---------------------------------------------------------------------------
  const existingBranch = await knex('branches').where({ code: 'EC' }).first();
  if (existingBranch) {
    await knex('branches').where({ id: existingBranch.id }).update({
      name: 'Sucursal Ecatepec',
      is_active: true,
      updated_at: knex.fn.now(),
    });
  } else {
    await knex('branches').insert({
      id: ECATEPEC_BRANCH_ID,
      name: 'Sucursal Ecatepec',
      code: 'EC',
      is_active: true,
    });
  }
  const branchEcatepec = await knex('branches').where({ code: 'EC' }).first();
  const branchId = branchEcatepec.id;

  // ---------------------------------------------------------------------------
  // 2) Virtual users from AUTH_DIRECTORY_JSON
  // ---------------------------------------------------------------------------
  const raw = process.env.AUTH_DIRECTORY_JSON;
  if (!raw) {
    // No virtual users configured. The migration is still considered done —
    // operators can re-run it after setting AUTH_DIRECTORY_JSON.
    // eslint-disable-next-line no-console
    console.warn('[042] AUTH_DIRECTORY_JSON not set; skipping virtual user seed.');
    return;
  }

  let customUsers;
  try {
    customUsers = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[042] AUTH_DIRECTORY_JSON is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(customUsers) || customUsers.length === 0) {
    return;
  }

  // Hash passwords once. We use the plaintext password from the directory so
  // that DB-backed login (when isExternalDataMode() is later turned off) still
  // works without manual reset.
  const hashed = await Promise.all(customUsers.map(async (u) => ({
    src: u,
    password_hash: await bcrypt.hash(String(u.password || ''), 10),
  })));

  // Build rows with manager_id resolved to UUIDs.
  const rows = hashed.map(({ src, password_hash }) => {
    const managerVirtualId = findManagerVirtualId(src, customUsers);
    return {
      id: virtualToUuid(src.id),
      external_id: src.id,
      email: String(src.email || '').trim().toLowerCase(),
      password_hash,
      full_name: src.full_name,
      role: src.role,
      is_active: src.is_active !== false,
      employee_code: src.employee_code || null,
      employee_number: src.employee_number || null,
      branch_id: src.branch_code === 'EC' ? branchId : null,
      manager_id: managerVirtualId ? virtualToUuid(managerVirtualId) : null,
      must_change_password: false,
    };
  });

  // Insert without manager_id first, then patch (avoids self-FK ordering
  // pitfalls on first run).
  for (const r of rows) {
    const { manager_id, ...withoutManager } = r;
    const exists = await knex('users').where({ id: r.id }).first();
    if (exists) {
      await knex('users').where({ id: r.id }).update({
        ...withoutManager,
        updated_at: knex.fn.now(),
      });
    } else {
      await knex('users').insert(withoutManager);
    }
  }
  for (const r of rows) {
    if (r.manager_id) {
      await knex('users').where({ id: r.id }).update({ manager_id: r.manager_id });
    }
  }

  // ---------------------------------------------------------------------------
  // 3) Wire branch.director_user_id → director_sucursal user
  // ---------------------------------------------------------------------------
  const director = customUsers.find((u) => u.role === 'director_sucursal' && u.branch_code === 'EC');
  if (director) {
    await knex('branches')
      .where({ id: branchId })
      .update({ director_user_id: virtualToUuid(director.id), updated_at: knex.fn.now() });
  }
};

exports.down = async function down(knex) {
  const raw = process.env.AUTH_DIRECTORY_JSON;
  let customUsers = [];
  if (raw) {
    try { customUsers = JSON.parse(raw); } catch { /* no-op */ }
  }
  const ids = customUsers.map((u) => virtualToUuid(u.id));

  await knex('branches').where({ code: 'EC' }).update({ director_user_id: null });
  if (ids.length) {
    await knex('users').whereIn('id', ids).delete();
  }
  await knex('branches').where({ code: 'EC' }).delete();
};
