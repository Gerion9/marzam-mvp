const service = require('./alerts.service');

async function listDismissals(req, res, next) {
  try {
    const rows = await service.listDismissals(req.user.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function dismiss(req, res, next) {
  try {
    const row = await service.dismiss({
      userId: req.user.id,
      alertKey: req.body.alert_key,
      expiresAt: req.body.expires_at || null,
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

async function undismiss(req, res, next) {
  try {
    const result = await service.undismiss({
      userId: req.user.id,
      alertKey: req.params.key,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { listDismissals, dismiss, undismiss };
