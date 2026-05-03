#!/usr/bin/env node
/**
 * Generate the AUTH_DIRECTORY_JSON env var from the live Marzam source.
 *
 * Why:
 *   While the destination `users` table cannot exist (CREATE blocked, see
 *   docs/ROADMAP-PRODUCTION.md), we run the app in `AUTH_DIRECTORY_PROVIDER=virtual`
 *   mode. This script materializes the virtual directory directly from
 *   `int_marzam_cuadro_basico` + `stg_marzam_detalle_mostrador` so every real
 *   employee gets a login that matches the rest of the system.
 *
 * Email convention (matches the rest of the codebase, decision 2026-04-29):
 *   - representante / supervisor (clave is unique in cuadro_basico):
 *       <clave_lower>@marzam.mx          e.g. uea06@marzam.mx
 *   - gerente (clave='GERENTE' literal in source for all 6 → synthesized):
 *       ger_<apellido_paterno>@marzam.mx e.g. ger_garduno_perez@marzam.mx
 *   - director_sucursal (does NOT exist in source — synthesized from env):
 *       director@marzam.mx               (singleton, top of the tree)
 *
 * Branch / manager codes:
 *   - rep:        manager_code = supervisor_code (3 letters, e.g. UEA), branch_code = gerencia (2 letters, e.g. UE)
 *   - supervisor: manager_code = its gerente's synthesized code, branch_code = gerencia
 *   - gerente:    manager_code = director's id (top role), branch_code = own gerencia(s) joined
 *   - director:   manager_code = null, branch_code = null
 *
 * Passwords (configurable, sane defaults):
 *   - default Rep2026!   for representante and supervisor
 *   - default Mgr2026!   for gerente_ventas
 *   - read DIRECTOR_PASSWORD from env or fallback to Director2026!
 *   All emit must_change_password=true so the user is forced to rotate on first
 *   login (handled by the app once the change-password endpoint exists).
 *
 * Output modes:
 *   --format=env-json   (default) prints  AUTH_DIRECTORY_JSON=<minified-json>
 *   --format=pretty     prints the array indented for review
 *   --format=summary    just role counts + a few sample rows
 *   --output PATH       writes the resulting JSON to PATH instead of stdout
 *
 * Examples:
 *   node scripts/generate-auth-directory.js                         # for .env
 *   node scripts/generate-auth-directory.js --format pretty | less   # review
 *   node scripts/generate-auth-directory.js --output auth-dir.json   # save
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  fetchAll, BQ_TABLES, buildKeyMap, pickFirst, asString,
} = require('../src/modules/bq-sync/bqHelpers');
const {
  rangoToRole, synthGerenteCode, tokenize, synthesizeEmail,
} = require('../src/modules/bq-sync/jobs/syncCuadroBasico');
const { ROLES } = require('../src/constants/roles');
const { getMarzamSourceDb, destroyMarzamSourceDb } = require('../src/integrations/marzamSource/client');

function parseArgs(argv) {
  const args = { format: 'env-json', output: null, role: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--format') { args.format = next; i += 1; }
    else if (a === '--output') { args.output = next; i += 1; }
    else if (a === '--role') { args.role = next; i += 1; }
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/generate-auth-directory.js [options]
  --format env-json|pretty|summary   default: env-json
  --output PATH                       write to file instead of stdout
  --role ROLE                         filter to a single role (debug)
  --help                              this message`);
      process.exit(0);
    }
  }
  return args;
}

function readPasswords() {
  return {
    rep: process.env.AUTH_DIR_REP_PASSWORD || 'Rep2026!',
    supervisor: process.env.AUTH_DIR_SUPERVISOR_PASSWORD || 'Sup2026!',
    gerente: process.env.AUTH_DIR_GERENTE_PASSWORD || 'Mgr2026!',
    director: process.env.DIRECTOR_PASSWORD || 'Director2026!',
  };
}

function uniqueIfNeeded(emailBase, taken) {
  let candidate = emailBase;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = emailBase.replace('@', `${n}@`);
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}

async function main() {
  const args = parseArgs(process.argv);
  const passwords = readPasswords();

  // 1. cuadro_basico → all leaf employees with their canonical employee_code
  const rawCuadro = await fetchAll(BQ_TABLES.CUADRO_BASICO);
  if (!rawCuadro.length) {
    console.error('No rows in cuadro_basico — aborting.');
    process.exit(1);
  }
  const km = buildKeyMap(rawCuadro[0]);

  // 2. detalle_mostrador → distinct hierarchy triplets so we can attribute
  //    each employee to a (branch, supervisor) pair.
  const sourceDb = getMarzamSourceDb();
  const triplets = await sourceDb
    .withSchema('staging')
    .from('stg_marzam_detalle_mostrador')
    .distinct('gerencia', 'gerente', 'supervisor', 'supervisor_nombre', 'agente', 'representante')
    .whereNotNull('gerencia');

  // 3. Build attribution maps.
  //
  //    Important: in cuadro_basico names are "Nombre Apellido1 Apellido2";
  //    in detalle_mostrador they are "Apellido1 Apellido2 Nombre". Plus
  //    detalle_mostrador sometimes drops the Nombre entirely (just the two
  //    surnames). So we match by token *set intersection* with a threshold
  //    of >= 2 shared tokens, falling back to >= 1 only if both names have
  //    a single token.
  const repAttribution = new Map();   // rep clave → attribution
  const supervisorEntries = [];       // [{ tokenSet, branch, supervisor_code, gerente_name }]
  const gerenteEntries = [];          // [{ tokenSet, branches: Set }]

  function tokensOf(name) {
    return new Set(tokenize(name).split('_').filter(Boolean));
  }
  function bestMatch(targetTokens, entries) {
    if (!targetTokens || targetTokens.size === 0) return null;
    let bestScore = 0;
    let best = null;
    for (const e of entries) {
      let shared = 0;
      for (const t of targetTokens) if (e.tokenSet.has(t)) shared += 1;
      if (shared > bestScore) {
        bestScore = shared;
        best = e;
      }
    }
    const minShared = (targetTokens.size === 1) ? 1 : 2;
    return bestScore >= minShared ? best : null;
  }

  for (const t of triplets) {
    const branch = asString(t.gerencia);
    if (!branch) continue;
    const supCode = asString(t.supervisor);
    const supName = asString(t.supervisor_nombre);
    const gerName = asString(t.gerente);
    const agente = asString(t.agente);

    if (agente && !repAttribution.has(agente)) {
      repAttribution.set(agente, {
        branch_code: branch,
        supervisor_code: supCode,
        supervisor_name: supName === 'VACANTE' ? null : supName,
        gerente_name: gerName === 'VACANTE' ? null : gerName,
      });
    }
    if (supName && supName !== 'VACANTE') {
      const tokenSet = tokensOf(supName);
      // collapse repeats by token-set equality
      const dup = supervisorEntries.find((e) => e.tokenSet.size === tokenSet.size
        && [...e.tokenSet].every((x) => tokenSet.has(x)));
      if (!dup) {
        supervisorEntries.push({
          tokenSet, branch, supervisor_code: supCode,
          gerente_name: gerName === 'VACANTE' ? null : gerName,
        });
      }
    }
    if (gerName && gerName !== 'VACANTE') {
      const tokenSet = tokensOf(gerName);
      const existing = gerenteEntries.find((e) => e.tokenSet.size === tokenSet.size
        && [...e.tokenSet].every((x) => tokenSet.has(x)));
      if (existing) existing.branches.add(branch);
      else gerenteEntries.push({ tokenSet, branches: new Set([branch]) });
    }
  }

  // 4. Director sintético (no aparece en source). Una sola entrada raíz.
  const DIRECTOR_ID = 'DIR001';
  const DIRECTOR_EMAIL = process.env.DIRECTOR_EMAIL || 'director@marzam.mx';
  const DIRECTOR_NAME = process.env.DIRECTOR_NAME || 'Director Marzam';
  const directorEntry = {
    id: DIRECTOR_ID,
    email: DIRECTOR_EMAIL,
    password: passwords.director,
    full_name: DIRECTOR_NAME,
    role: ROLES.DIRECTOR_SUCURSAL,
    is_active: true,
    employee_code: DIRECTOR_ID,
    employee_number: null,
    branch_code: null,
    manager_code: null,
    must_change_password: true,
  };

  // 5. Walk cuadro_basico
  const takenEmails = new Set([directorEntry.email]);
  const directory = [directorEntry];
  const skippedNoCode = [];
  const synthesizedGerentes = new Map(); // tokenized name → entry (so we can dedupe)

  let vacantesCount = 0;
  for (const raw of rawCuadro) {
    const rawCode = asString(pickFirst(raw, ['clave', 'employee_code'], km));
    const fullNameRaw = asString(pickFirst(raw, ['nombre_del_empleado', 'nombre'], km));
    const fullName = fullNameRaw || rawCode;
    const employeeNumber = asString(pickFirst(raw, ['no_empleado'], km));
    const rangoRaw = asString(pickFirst(raw, ['rango'], km));
    const role = rangoToRole(rangoRaw) || ROLES.REPRESENTANTE;
    const estatus = asString(pickFirst(raw, ['estatus', 'status'], km));

    if (!rawCode || !fullName) {
      skippedNoCode.push({ rawCode, fullName, rangoRaw });
      continue;
    }

    // VACANTE rows are placeholders for unfilled positions — keep their
    // employee_code reserved (so when RH fills them we don't shift codes)
    // but mark them inactive so they cannot log in.
    const isVacante = !fullNameRaw
      || tokenize(fullNameRaw) === 'VACANTE'
      || (estatus && tokenize(estatus) === 'VACANTE');
    const isActive = !isVacante && (!estatus || tokenize(estatus) !== 'BAJA');
    if (isVacante) vacantesCount += 1;

    let employeeCode = rawCode;
    let email;
    let password;
    let branch_code = null;
    let manager_code = null;

    if (role === ROLES.GERENTE_VENTAS && rawCode.toUpperCase() === 'GERENTE') {
      // Synthesize unique code from name (6 gerentes share clave='GERENTE')
      employeeCode = synthGerenteCode(fullName);
      const tok = tokenize(fullName);
      // Dedupe in case cuadro_basico has duplicate gerente rows for the same person
      if (synthesizedGerentes.has(tok)) continue;
      const tokens = tokensOf(fullName);
      const match = bestMatch(tokens, gerenteEntries);
      branch_code = match ? [...match.branches].sort().join(',') : null;
      manager_code = DIRECTOR_ID;
      email = uniqueIfNeeded(synthesizeEmail(employeeCode), takenEmails);
      password = passwords.gerente;
      const entry = {
        id: employeeCode,
        email,
        password,
        full_name: fullName,
        role,
        is_active: isActive,
        employee_code: employeeCode,
        employee_number: employeeNumber,
        branch_code,
        manager_code,
        must_change_password: true,
      };
      synthesizedGerentes.set(tok, entry);
      directory.push(entry);
      continue;
    }

    if (role === ROLES.SUPERVISOR) {
      // Their clave in cuadro_basico is unique (5 chars, distinct from the
      // 3-letter operational code in detalle_mostrador). We attribute them
      // by matching their full_name (tolerant to ordering) to
      // detalle_mostrador.supervisor_nombre.
      const tokens = tokensOf(fullName);
      const att = bestMatch(tokens, supervisorEntries);
      branch_code = att ? att.branch : null;
      // If we found the 3-letter operational code, we keep it as a hint in
      // a parallel field (not employee_code, since that must equal `clave`
      // for cross-referencing future user inserts).
      const operationalCode = att ? att.supervisor_code : null;
      // manager = the gerente that owns this branch
      let gerEntry = null;
      if (att && att.gerente_name) {
        const gerTokens = tokensOf(att.gerente_name);
        for (const [tok, entry] of synthesizedGerentes.entries()) {
          const entryTokens = new Set(tok.split('_'));
          let shared = 0;
          for (const x of gerTokens) if (entryTokens.has(x)) shared += 1;
          if (shared >= 2 || (gerTokens.size === 1 && shared === 1)) {
            gerEntry = entry; break;
          }
        }
      }
      manager_code = gerEntry ? gerEntry.employee_code : DIRECTOR_ID;
      email = uniqueIfNeeded(synthesizeEmail(employeeCode), takenEmails);
      password = passwords.supervisor;
      directory.push({
        id: employeeCode,
        email,
        password,
        full_name: fullName,
        role,
        is_active: isActive,
        employee_code: employeeCode,
        employee_number: employeeNumber,
        branch_code,
        manager_code,
        operational_code: operationalCode,
        must_change_password: true,
      });
      continue;
    }

    // Default: representante (also catches role unknowns).
    const att = repAttribution.get(rawCode);
    if (att) {
      branch_code = att.branch_code;
      // The rep's manager is the supervisor — find that supervisor entry by
      // operational_code matching what's in detalle_mostrador. We do this
      // in a second pass below since synthesized supervisors may not have
      // populated operational_code yet by the time this rep is processed
      // depending on cuadro_basico ordering.
      manager_code = att.supervisor_code; // operational code for now; resolved below
    }
    email = uniqueIfNeeded(synthesizeEmail(employeeCode), takenEmails);
    password = passwords.rep;
    directory.push({
      id: employeeCode,
      email,
      password,
      full_name: fullName,
      role: ROLES.REPRESENTANTE,
      is_active: isActive,
      employee_code: employeeCode,
      employee_number: employeeNumber,
      branch_code,
      manager_code,
      must_change_password: true,
    });
  }

  // 6. Resolve rep.manager_code (currently the operational supervisor code,
  //    e.g. "UEA") to the supervisor's actual employee_code (their `clave`
  //    in cuadro_basico, e.g. "ABC12") so JWTs and the read-through layer
  //    cross-reference cleanly.
  const supByOperational = new Map();
  for (const u of directory) {
    if (u.role === ROLES.SUPERVISOR && u.operational_code) {
      supByOperational.set(u.operational_code, u.employee_code);
    }
  }
  for (const u of directory) {
    if (u.role === ROLES.REPRESENTANTE && u.manager_code) {
      const resolved = supByOperational.get(u.manager_code);
      if (resolved) u.manager_code = resolved;
      // else: leave the operational code; consumer can fall back to it
    }
  }
  // operational_code is internal — drop it from output to keep payload small
  for (const u of directory) delete u.operational_code;

  // 7. Output
  const counts = directory.reduce((acc, u) => {
    acc[u.role] = (acc[u.role] || 0) + 1;
    return acc;
  }, {});
  const activeCount = directory.filter((u) => u.is_active).length;
  const meta = { active: activeCount, inactive: directory.length - activeCount, vacantes: vacantesCount };

  if (args.role) {
    const filtered = directory.filter((u) => u.role === args.role);
    return emit(args, filtered, counts, skippedNoCode, meta);
  }
  return emit(args, directory, counts, skippedNoCode, meta);
}

function emit(args, directory, counts, skipped, meta) {
  const minified = JSON.stringify(directory);
  const pretty = JSON.stringify(directory, null, 2);

  if (args.format === 'summary') {
    const out = {
      total: directory.length,
      by_role: counts,
      meta,
      sample: directory.slice(0, 5),
      skipped_count: skipped.length,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (args.output) {
    fs.writeFileSync(path.resolve(args.output), minified, 'utf8');
    console.error(`✓ wrote ${directory.length} entries (${minified.length.toLocaleString()} bytes) to ${args.output}`);
    console.error(`  by role: ${JSON.stringify(counts)}`);
    console.error(`  meta: ${JSON.stringify(meta)}`);
    return;
  }

  if (args.format === 'pretty') {
    console.log(pretty);
    return;
  }

  // Default: env-json. Print a single line "AUTH_DIRECTORY_JSON=..." so it
  // can be `>>` appended to .env directly. Diagnostics go to stderr so they
  // don't pollute the redirect.
  console.error(`# Generated ${directory.length} virtual users`);
  console.error(`# By role: ${JSON.stringify(counts)}`);
  console.error(`# Active/Inactive: ${meta.active}/${meta.inactive} (${meta.vacantes} VACANTE positions deactivated)`);
  if (skipped.length) console.error(`# Skipped (no code or no name): ${skipped.length}`);
  console.error(`# Size: ${minified.length.toLocaleString()} bytes`);
  console.log(`AUTH_DIRECTORY_JSON=${minified}`);
}

main()
  .catch((e) => {
    console.error('FATAL:', e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await destroyMarzamSourceDb();
  });
