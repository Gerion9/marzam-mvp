const db = require('../../config/database');
const { isExternalDataMode } = require('../../repositories/runtime');

async function listDismissals(userId) {
  if (isExternalDataMode()) return [];
  const now = db.fn.now();
  return db('alert_dismissals')
    .where({ user_id: userId })
    .andWhere(function () {
      this.whereNull('expires_at').orWhere('expires_at', '>', now);
    })
    .select('id', 'alert_key', 'dismissed_at', 'expires_at')
    .orderBy('dismissed_at', 'desc');
}

async function dismiss({ userId, alertKey, expiresAt = null }) {
  if (!alertKey) {
    const err = new Error('alert_key is required');
    err.status = 400;
    throw err;
  }
  if (isExternalDataMode()) {
    return { id: null, alert_key: alertKey, dismissed_at: new Date().toISOString(), expires_at: expiresAt };
  }
  const [row] = await db('alert_dismissals')
    .insert({
      user_id: userId,
      alert_key: alertKey,
      expires_at: expiresAt || null,
    })
    .returning(['id', 'alert_key', 'dismissed_at', 'expires_at']);
  return row;
}

async function undismiss({ userId, alertKey }) {
  if (isExternalDataMode()) return { removed: 0 };
  const deleted = await db('alert_dismissals')
    .where({ user_id: userId, alert_key: alertKey })
    .delete();
  return { removed: deleted };
}

module.exports = { listDismissals, dismiss, undismiss };
