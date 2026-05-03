const territoriesRepository = require('../repositories/territoriesRepository');
const { isExternalDataMode } = require('../repositories/runtime');
const { normalizeRole, isGlobalRole: isGlobalRoleConst } = require('../constants/roles');

const GLOBAL_ROLES = new Set(['director_sucursal', 'national_admin', 'manager']);

/**
 * Resolve the territorial scope of a user.
 *
 * Returns an object the rest of the codebase can use to filter data:
 *   {
 *     isGlobal: boolean                       // true => see everything
 *     territoryIds: string[]                  // flat list of territory UUIDs the user owns (direct assignments)
 *     accessibleTerritoryIds: string[]        // all descendants (including self) — what they can SEE
 *     role: string                            // user's role
 *     dataScope: string|null                  // legacy data_scope flag (virtual directory)
 *   }
 *
 * For global roles (national_admin / legacy manager), isGlobal=true and the
 * territory arrays are empty — meaning "no filter".
 */
async function computeUserScope(user) {
  if (!user) {
    return { isGlobal: false, territoryIds: [], accessibleTerritoryIds: [], role: null, dataScope: null };
  }

  const role = user.role;
  const dataScope = user.data_scope || null;

  if (GLOBAL_ROLES.has(role)) {
    return { isGlobal: true, territoryIds: [], accessibleTerritoryIds: [], role, dataScope };
  }

  if (isExternalDataMode()) {
    return { isGlobal: false, territoryIds: [], accessibleTerritoryIds: [], role, dataScope };
  }

  const assignments = await territoriesRepository.getUserTerritories(user.id);
  const directIds = assignments.map((a) => a.territory_id);
  const accessibleTerritoryIds = directIds.length
    ? await territoriesRepository.listDescendantIds(directIds)
    : [];

  return {
    isGlobal: false,
    territoryIds: directIds,
    accessibleTerritoryIds,
    role,
    dataScope,
  };
}

function isGlobalRole(role) {
  return GLOBAL_ROLES.has(role) || isGlobalRoleConst(normalizeRole(role));
}

module.exports = { computeUserScope, isGlobalRole };
