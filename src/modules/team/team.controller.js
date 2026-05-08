const service = require('./team.service');
const accessDirectory = require('../../services/accessDirectory');

const EMPTY_CASCADE = Object.freeze({
  actor: null,
  descendants: [],
  by_role: {},
  direct_reports: [],
});

/**
 * Indica si un error es de conectividad con la BD (Postgres). En esos
 * casos preferimos devolver shape vacía con 200 para que el frontend
 * no se rompa, en lugar de propagar 500. La BD volverá a estar viva
 * en el siguiente request (knex reconecta).
 */
function isDbConnectionError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('connection terminated')
    || msg.includes('connection ended')
    || msg.includes('econnreset')
    || msg.includes('etimedout')
    || msg.includes('connect econn')
    || err.code === 'ECONNRESET'
    || err.code === 'ETIMEDOUT'
    || err.code === '57P01' // admin_shutdown
    || err.code === '57P02' // crash_shutdown
    || err.code === '57P03' // cannot_connect_now
  );
}

async function cascade(req, res, next) {
  try {
    const result = await service.getCascade({
      userId: req.user.id,
      dateFrom: req.query.from,
      dateTo: req.query.to,
      actor: req.user,
    });
    res.json(result);
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.warn(`[team.cascade] DB connection issue, returning empty cascade: ${err.message}`);
      return res.json({ ...EMPTY_CASCADE, actor: { id: req.user.id, role: req.user.role, full_name: req.user.full_name } });
    }
    next(err);
  }
}

async function descendants(req, res, next) {
  try {
    const result = await service.getDescendantsEnriched({
      userId: req.user.id,
      actor: req.user,
    });
    res.json(result);
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.warn(`[team.descendants] DB connection issue, returning empty: ${err.message}`);
      return res.json([]);
    }
    next(err);
  }
}

async function member(req, res, next) {
  try {
    const result = await service.getMember({
      actorId: req.user.id,
      targetUserId: accessDirectory.toCanonicalId(req.params.userId),
      isGlobal: req.user.is_global,
      dateFrom: req.query.from,
      dateTo: req.query.to,
    });
    res.json(result);
  } catch (err) {
    if (isDbConnectionError(err)) {
      console.warn(`[team.member] DB connection issue, returning empty member: ${err.message}`);
      return res.json({ user: null, direct_reports: [] });
    }
    next(err);
  }
}

module.exports = { cascade, member, descendants };
