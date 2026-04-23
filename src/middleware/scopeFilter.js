const config = require('../config');

const SCOPE_FILTERING_ENABLED = process.env.SCOPE_FILTERING_ENABLED !== 'false';

function isScopeFilteringEnabled() {
  return SCOPE_FILTERING_ENABLED && config.env !== 'test';
}

/**
 * Apply territory scope filter to a Knex query builder.
 * - If scope is missing, global, or empty, the query is returned unchanged.
 * - Otherwise, adds WHERE column IN (accessibleTerritoryIds).
 */
function applyTerritoryFilter(query, column, scope) {
  if (!isScopeFilteringEnabled()) return query;
  if (!scope || scope.isGlobal) return query;
  const ids = scope.accessibleTerritoryIds || [];
  if (ids.length === 0) {
    return query.whereRaw('1 = 0');
  }
  return query.whereIn(column, ids);
}

/**
 * Check whether a given territory_id falls inside the caller scope.
 */
function canAccessTerritory(scope, territoryId) {
  if (!scope || scope.isGlobal) return true;
  if (!territoryId) return false;
  const ids = scope.accessibleTerritoryIds || [];
  return ids.includes(territoryId);
}

function canAccessPharmacy(scope, pharmacy) {
  if (!pharmacy) return false;
  if (!scope || scope.isGlobal) return true;
  return canAccessTerritory(scope, pharmacy.territory_id);
}

function canAccessAssignment(scope, assignment) {
  if (!assignment) return false;
  if (!scope || scope.isGlobal) return true;
  if (assignment.territory_id && canAccessTerritory(scope, assignment.territory_id)) return true;
  // Fallback: allow if user owns the assignment
  if (assignment.rep_id && scope.role === 'field_rep') {
    return true; // rep always accesses own assignments; ownership checked upstream
  }
  return false;
}

/**
 * Filter an array of plain objects by territory_id against the scope.
 * Used when we pull data from external repositories that can't be WHERE-filtered.
 */
function filterByScope(rows, scope, columnGetter = (r) => r.territory_id) {
  if (!isScopeFilteringEnabled()) return rows;
  if (!scope || scope.isGlobal) return rows;
  const allowed = new Set(scope.accessibleTerritoryIds || []);
  if (allowed.size === 0) return [];
  return rows.filter((row) => {
    const tid = columnGetter(row);
    if (!tid) return false;
    return allowed.has(tid);
  });
}

module.exports = {
  applyTerritoryFilter,
  canAccessTerritory,
  canAccessPharmacy,
  canAccessAssignment,
  filterByScope,
  isScopeFilteringEnabled,
};
