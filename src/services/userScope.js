const territoriesRepository = require('../repositories/territoriesRepository');
const { isExternalDataMode } = require('../repositories/runtime');
const { normalizeRole, isGlobalRole: isGlobalRoleConst } = require('../constants/roles');

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
 * For global roles (admin / director_sucursal and their legacy aliases),
 * isGlobal=true and the territory arrays are empty — meaning "no filter".
 */
async function computeUserScope(user) {
  if (!user) {
    return { isGlobal: false, territoryIds: [], accessibleTerritoryIds: [], role: null, dataScope: null };
  }

  const rawRole = user.role;
  const role = normalizeRole(rawRole) || rawRole;
  const dataScope = user.data_scope || null;

  if (isGlobalRoleConst(role)) {
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
  return isGlobalRoleConst(normalizeRole(role));
}

module.exports = { computeUserScope, isGlobalRole };
