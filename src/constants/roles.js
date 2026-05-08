/**
 * Centralized role definitions for the Marzam business hierarchy.
 *
 * Hierarchy (top → bottom):
 *   admin              → BlackPrint + 1–3 Marzam admins (global, exclusive)
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
 * It is globally permitted by the rbac middleware (sees every endpoint).
 *
 * The legacy role names (national_admin, regional_manager, area_coordinator,
 * field_rep, manager) remain accepted as aliases at the rbac/auth layer for a
 * transition period — see normalizeRole() and ROLE_ALIASES below.
 */

const ROLES = Object.freeze({
  ADMIN: 'admin',
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

const GLOBAL_ROLES = Object.freeze(new Set([ROLES.ADMIN, ROLES.DIRECTOR_SUCURSAL]));
const MANAGEMENT_ROLES = Object.freeze(new Set([
  ROLES.ADMIN,
  ROLES.DIRECTOR_SUCURSAL,
  ROLES.GERENTE_VENTAS,
  ROLES.SUPERVISOR,
]));

// Roles that may perform privileged config writes (A/B/C edit, sales targets,
// user CRUD, global config). Only admin per Marzam Execution Doc §3.
const ADMIN_ONLY_ROLES = Object.freeze(new Set([ROLES.ADMIN]));

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

module.exports = {
  ROLES,
  ROLE_VALUES,
  ROLE_ALIASES,
  ALL_ACCEPTED_ROLES,
  GLOBAL_ROLES,
  MANAGEMENT_ROLES,
  ADMIN_ONLY_ROLES,
  normalizeRole,
  isGlobalRole,
  isManagementRole,
  isAdminRole,
};
