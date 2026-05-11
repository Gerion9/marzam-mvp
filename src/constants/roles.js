/**
 * Centralized role definitions for the Marzam business hierarchy.
 *
 * Hierarchy (top → bottom):
 *   admin              → 1–3 Marzam admins (the client's own super-users; global, exclusive)
 *   blackprint_admin   → BlackPrint platform operators (read-only on Marzam data + exclusive
 *                        platform-health endpoints; global scope, NEVER writes Marzam state)
 *   director_sucursal  → branch director (was: national_admin)
 *   gerente_ventas     → sales manager  (was: regional_manager)
 *   supervisor         → supervisor     (was: area_coordinator)
 *   representante      → field rep      (was: field_rep)
 *
 * `admin` is the only role allowed (per Marzam Execution Doc §3) to:
 *   - edit A/B/C client classification
 *   - edit sales targets
 *   - create/delete users
 *   - manage global configuration
 * The rbac middleware always adds `admin` to non-empty role gates (see
 * expandAllowed). `blackprint_admin` is NOT auto-added — endpoints that want
 * to admit it must opt in via authorize({ anyAdmin: true }) for shared reads,
 * authorize({ blackprintOnly: true }) for BP-exclusive endpoints, or
 * authorize({ roles: [...], includeBlackprint: true }) for management gates
 * that should also accept BP. The denyBlackprintWrites middleware enforces a
 * platform-wide write block as defense in depth.
 *
 * The legacy role names (national_admin, regional_manager, area_coordinator,
 * field_rep, manager) remain accepted as aliases at the rbac/auth layer for a
 * transition period — see normalizeRole() and ROLE_ALIASES below.
 */

const ROLES = Object.freeze({
  ADMIN: 'admin',
  BLACKPRINT_ADMIN: 'blackprint_admin',
  DIRECTOR_SUCURSAL: 'director_sucursal',
  GERENTE_VENTAS: 'gerente_ventas',
  SUPERVISOR: 'supervisor',
  REPRESENTANTE: 'representante',
});

const ROLE_VALUES = Object.freeze(Object.values(ROLES));

const ROLE_ALIASES = Object.freeze({
  manager: ROLES.DIRECTOR_SUCURSAL,
  national_admin: ROLES.DIRECTOR_SUCURSAL,
  regional_manager: ROLES.GERENTE_VENTAS,
  area_coordinator: ROLES.SUPERVISOR,
  field_rep: ROLES.REPRESENTANTE,
  // Spanish forms surfaced by `int_marzam_cuadro_basico.rango`
  director: ROLES.DIRECTOR_SUCURSAL,
  director_de_sucursal: ROLES.DIRECTOR_SUCURSAL,
  gerencia: ROLES.GERENTE_VENTAS,
  gerente: ROLES.GERENTE_VENTAS,
  gerente_de_ventas: ROLES.GERENTE_VENTAS,
  supervisora: ROLES.SUPERVISOR,
  agente: ROLES.REPRESENTANTE,
  representante_medico: ROLES.REPRESENTANTE,
  representante_de_ventas: ROLES.REPRESENTANTE,
  vendedor: ROLES.REPRESENTANTE,
});

const ALL_ACCEPTED_ROLES = Object.freeze([...ROLE_VALUES, ...Object.keys(ROLE_ALIASES)]);

// Roles whose JWT may legitimately carry is_global=true (no territorial filtering).
// blackprint_admin is global because BP needs full read-only visibility across
// all branches/territories for support and diagnostics.
const GLOBAL_ROLES = Object.freeze(new Set([
  ROLES.ADMIN,
  ROLES.DIRECTOR_SUCURSAL,
  ROLES.BLACKPRINT_ADMIN,
]));
const MANAGEMENT_ROLES = Object.freeze(new Set([
  ROLES.ADMIN,
  ROLES.DIRECTOR_SUCURSAL,
  ROLES.GERENTE_VENTAS,
  ROLES.SUPERVISOR,
]));

// Roles that may perform privileged config writes (A/B/C edit, sales targets,
// user CRUD, global config). Only admin per Marzam Execution Doc §3.
// IMPORTANT: blackprint_admin is intentionally NOT here — BP is read-only on
// Marzam business data. The denyBlackprintWrites middleware enforces this at
// the HTTP layer as defense in depth.
const ADMIN_ONLY_ROLES = Object.freeze(new Set([ROLES.ADMIN]));

// Roles allowed on read-only endpoints shared between Marzam admin and the
// BlackPrint platform team (cron health, error log, cockpit analytics, etc).
// Used by authorize({ anyAdmin: true }).
const ANY_ADMIN_ROLES = Object.freeze(new Set([
  ROLES.ADMIN,
  ROLES.BLACKPRINT_ADMIN,
]));

function normalizeRole(role) {
  if (!role) return role;
  return ROLE_ALIASES[role] || role;
}

function isGlobalRole(role) {
  return GLOBAL_ROLES.has(normalizeRole(role));
}

function isManagementRole(role) {
  return MANAGEMENT_ROLES.has(normalizeRole(role));
}

function isAdminRole(role) {
  return ADMIN_ONLY_ROLES.has(normalizeRole(role));
}

function isBlackprintAdmin(role) {
  return normalizeRole(role) === ROLES.BLACKPRINT_ADMIN;
}

function isAnyAdmin(role) {
  return ANY_ADMIN_ROLES.has(normalizeRole(role));
}

module.exports = {
  ROLES,
  ROLE_VALUES,
  ROLE_ALIASES,
  ALL_ACCEPTED_ROLES,
  GLOBAL_ROLES,
  MANAGEMENT_ROLES,
  ADMIN_ONLY_ROLES,
  ANY_ADMIN_ROLES,
  normalizeRole,
  isGlobalRole,
  isManagementRole,
  isAdminRole,
  isBlackprintAdmin,
  isAnyAdmin,
};
