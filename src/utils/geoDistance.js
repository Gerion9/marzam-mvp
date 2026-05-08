// Distance threshold above which a check-in / presence sample is flagged as
// suspicious. Mirrored as a literal in the SQL of presence.service.reconcileDay
// — keep them in sync if you change this number.
const DISTANCE_WARNING_THRESHOLD_M = 500;

const EARTH_RADIUS_M = 6371000;
const toRad = (value) => (Number(value) * Math.PI) / 180;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLng = toRad(Number(lng2) - Number(lng1));
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { haversineMeters, DISTANCE_WARNING_THRESHOLD_M };
