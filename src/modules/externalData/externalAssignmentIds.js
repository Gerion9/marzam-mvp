function buildAssignmentId({ wave_id, rep_id }) {
  return `${wave_id || 'default-wave'}::${rep_id || 'unassigned'}`;
}

function buildStopId({ assignment_id, pharmacy_id, route_order }) {
  return `${assignment_id}::${route_order || 0}::${pharmacy_id}`;
}

function parseStopId(stopId) {
  const parts = String(stopId || '').split('::').filter(Boolean);
  if (parts.length < 3) {
    return {
      assignment_id: parts[0] || null,
      route_order: null,
      pharmacy_id: null,
    };
  }

  const pharmacy_id = parts[parts.length - 1] || null;
  const routeOrderRaw = parts[parts.length - 2];
  const assignment_id = parts.slice(0, -2).join('::') || null;
  return {
    assignment_id,
    route_order: Number(routeOrderRaw || 0) || null,
    pharmacy_id,
  };
}

module.exports = {
  buildAssignmentId,
  buildStopId,
  parseStopId,
};
