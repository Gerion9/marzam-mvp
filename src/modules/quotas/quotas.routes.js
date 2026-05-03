const { Router } = require('express');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const auditLog = require('../../middleware/auditLog');
const service = require('./quotas.service');
const accessDirectory = require('../../services/accessDirectory');

const router = Router();

// Solo management roles pueden tocar quotas. Representantes quedan fuera.
const managementOnly = authorize({ roles: ['director_sucursal', 'gerente_ventas', 'supervisor'] });

router.get('/subordinates', authenticate, managementOnly, async (req, res, next) => {
  try { res.json(await service.listSubordinates(req.user.id)); } catch (err) { next(err); }
});

router.get('/', authenticate, managementOnly, async (req, res, next) => {
  try {
    const today = new Date();
    const defaultStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    const defaultEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10);
    const periodStart = req.query.period_start || defaultStart;
    const periodEnd = req.query.period_end || defaultEnd;
    const rows = await service.listQuotasByPeriod({ actorId: req.user.id, periodStart, periodEnd });
    res.json({ period_start: periodStart, period_end: periodEnd, rows });
  } catch (err) { next(err); }
});

router.post('/', authenticate, managementOnly, auditLog('quota.upsert'), async (req, res, next) => {
  try {
    const q = await service.upsertQuota({
      actorId: req.user.id,
      targetUserId: accessDirectory.toCanonicalId(req.body.target_user_id),
      periodStart: req.body.period_start,
      periodEnd: req.body.period_end,
      targetNew: req.body.target_new,
      targetExisting: req.body.target_existing,
      mode: req.body.mode || 'custom',
      notes: req.body.notes,
    });
    res.status(201).json(q);
  } catch (err) { next(err); }
});

router.post('/uniform', authenticate, managementOnly, auditLog('quota.uniform'), async (req, res, next) => {
  try {
    const result = await service.applyUniform({
      actorId: req.user.id,
      periodStart: req.body.period_start,
      periodEnd: req.body.period_end,
      targetNew: req.body.target_new,
      targetExisting: req.body.target_existing,
      notes: req.body.notes,
    });
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
