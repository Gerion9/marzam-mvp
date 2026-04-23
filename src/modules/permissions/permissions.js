/**
 * Central permission helpers.
 *
 * Role hierarchy (top to bottom, each includes all privileges of roles below it):
 *   national_admin   → global scope, can do anything
 *   regional_manager → scope over its regional/municipal territories
 *   area_coordinator → scope over its municipal/zone territories
 *   field_rep        → only its own assignments and visits
 *
 * Legacy `manager` is treated as `national_admin`.
 */

const ROLE_RANK = {
  field_rep: 1,
  area_coordinator: 2,
  regional_manager: 3,
  national_admin: 4,
  manager: 4, // legacy
};

const GLOBAL_ROLES = new Set(['national_admin', 'manager']);

function rankOf(role) {
  return ROLE_RANK[role] || 0;
}

function isGlobal(role) {
  return GLOBAL_ROLES.has(role);
}

/**
 * Is the actor strictly above the target in the hierarchy?
 */
function isAbove(actorRole, targetRole) {
  return rankOf(actorRole) > rankOf(targetRole);
}

/**
 * Is the given territory inside the user's scope?
 * Global roles: always true.
 * Otherwise: must appear in accessibleTerritoryIds.
 */
function canAccessTerritory(user, territoryId) {
  if (!user) return false;
  if (isGlobal(user.role) || user.is_global) return true;
  if (!territoryId) return false;
  const ids = user.accessible_territory_ids || [];
  return ids.includes(territoryId);
}

/**
 * Can actor manage (create/edit/deactivate) target user?
 * Rules:
 *   - Must be strictly above target in role hierarchy.
 *   - Target's territories (if any) must fall inside actor's scope.
 */
function canManageUser(actor, target) {
  if (!actor || !target) return false;
  if (!isAbove(actor.role, target.role)) return false;
  if (isGlobal(actor.role)) return true;
  const targetTerritories = target.accessible_territory_ids || target.territory_ids || [];
  if (targetTerritories.length === 0) return true; // unassigned user: only global can create
  return targetTerritories.every((tid) => canAccessTerritory(actor, tid));
}

/**
 * Can user create assignments (manual or wave)?
 * - Global roles: always.
 * - regional_manager / area_coordinator: if provided territory is within scope.
 * - field_rep: never.
 */
function canCreateAssignment(user, payload = {}) {
  if (!user) return false;
  if (user.role === 'field_rep') return false;
  if (isGlobal(user.role) || user.is_global) return true;
  if (!['regional_manager', 'area_coordinator'].includes(user.role)) return false;
  if (payload.territory_id) return canAccessTerritory(user, payload.territory_id);
  // No explicit territory: fallback to any scope territory.
  return (user.accessible_territory_ids || []).length > 0;
}

/**
 * Can user act on an existing assignment?
 * Rules:
 *   - Global: always.
 *   - field_rep: only if rep_id matches.
 *   - Others: if the assignment's territory is inside their scope.
 */
function canActOnAssignment(user, assignment) {
  if (!user || !assignment) return false;
  if (isGlobal(user.role) || user.is_global) return true;
  if (user.role === 'field_rep') return assignment.rep_id === user.id;
  if (assignment.territory_id && canAccessTerritory(user, assignment.territory_id)) return true;
  return false;
}

/**
 * Can user view a given report scope (territory)?
 */
function canViewReport(user, requestedTerritoryId = null) {
  if (!user) return false;
  if (isGlobal(user.role) || user.is_global) return true;
  if (!requestedTerritoryId) return true; // will be auto-scoped by data_scope filter
  return canAccessTerritory(user, requestedTerritoryId);
}

function canManageTerritories(user) {
  if (!user) return false;
  return isGlobal(user.role) || user.is_global;
}

module.exports = {
  ROLE_RANK,
  GLOBAL_ROLES,
  rankOf,
  isGlobal,
  isAbove,
  canAccessTerritory,
  canManageUser,
  canCreateAssignment,
  canActOnAssignment,
  canViewReport,
  canManageTerritories,
};
