const service = require('./role-capacity.service');

async function list(req, res, next) {
  try {
    const poblacion = req.query.poblacion || null;
    const rows = await service.listRoleCapacity({ poblacion });
    res.json(rows);
  } catch (err) { next(err); }
}

async function upsert(req, res, next) {
  try {
    const poblacion = req.body.poblacion ?? req.query.poblacion ?? null;
    const { role, target_headcount: targetHeadcount, days_per_month: daysPerMonth } = req.body || {};
    if (!role) return res.status(400).json({ error: 'role required' });
    const row = await service.upsertRoleCapacity({
      actor: req.user,
      poblacion: poblacion || null,
      role,
      targetHeadcount,
      daysPerMonth,
    });
    res.status(200).json(row);
  } catch (err) { next(err); }
}

module.exports = { list, upsert };
