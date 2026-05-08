/**
 * User invitations + password reset — Marzam Execution Doc §6.1.
 *
 * Public surface:
 *   - createInvitation({ userId, createdBy }): mints a one-shot token, sends
 *     the activation email, persists the row.  Idempotent within a 5-minute
 *     window: re-issuing for the same user invalidates outstanding invitations
 *     and creates a fresh token.
 *   - bulkCreateInvitations({ userIds, createdBy }): same but for a CSV/list.
 *   - validateActivationToken(token): returns the user row and email iff the
 *     token is fresh (not used, not expired, purpose='invitation').
 *   - completeActivation(token, password): hashes the password, marks the
 *     token used, returns the fresh JWT.
 *   - requestPasswordReset({ email }): issues a token with purpose='password_reset'
 *     and 1-hour expiry; never reveals whether the email exists (anti-enumeration).
 *   - completePasswordReset(token, password): same one-shot flow.
 *
 * Notes:
 *   - We DO NOT block users that are `is_active = false` — admins may want to
 *     pre-stage the row before sending the invite.  The activate flow flips
 *     `is_active = true` once the password is set.
 *   - Tokens are 32-byte hex (64 chars), random_bytes from node:crypto.
 *   - Email failures DO NOT roll back the invitation — we persist `send_error`
 *     so an admin can re-send without minting a new token.
 */

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../../config/database');
const mailer = require('../../services/mailer');
const { isExternalDataMode } = require('../../repositories/runtime');

const SALT_ROUNDS = 10;
const INVITATION_TTL_DAYS = Number(process.env.INVITATION_TTL_DAYS) || 7;
const RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES) || 60;

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function activateUrl(token) {
  return `${mailer.appBaseUrl()}/activate.html?token=${encodeURIComponent(token)}`;
}

function resetUrl(token) {
  return `${mailer.appBaseUrl()}/reset-password.html?token=${encodeURIComponent(token)}`;
}

function buildInvitationEmail(user, token) {
  const url = activateUrl(token);
  const days = INVITATION_TTL_DAYS;
  const text = [
    `Hola ${user.full_name || ''},`,
    ``,
    `Se creó tu cuenta en la plataforma Marzam. Para activarla y elegir tu contraseña, abre este enlace:`,
    ``,
    url,
    ``,
    `El enlace expira en ${days} días.`,
    ``,
    `Si no esperabas este correo, puedes ignorarlo.`,
    ``,
    `— Plataforma Marzam`,
  ].join('\n');
  const html = `
    <p>Hola ${escapeHtml(user.full_name || '')},</p>
    <p>Se creó tu cuenta en la plataforma Marzam. Para activarla y elegir tu contraseña, abre este enlace:</p>
    <p><a href="${escapeAttr(url)}">${escapeHtml(url)}</a></p>
    <p>El enlace expira en ${days} días.</p>
    <p>Si no esperabas este correo, puedes ignorarlo.</p>
    <p style="color:#888">— Plataforma Marzam</p>
  `;
  return {
    subject: 'Activa tu cuenta de Marzam',
    text,
    html,
  };
}

function buildResetEmail(user, token) {
  const url = resetUrl(token);
  const text = [
    `Hola ${user.full_name || ''},`,
    ``,
    `Recibimos una solicitud para restablecer tu contraseña en Marzam.`,
    `Para elegir una nueva contraseña, abre este enlace (expira en ${RESET_TTL_MINUTES} minutos):`,
    ``,
    url,
    ``,
    `Si no fuiste tú, ignora este correo — tu contraseña actual sigue siendo válida.`,
    ``,
    `— Plataforma Marzam`,
  ].join('\n');
  return {
    subject: 'Restablece tu contraseña — Marzam',
    text,
    html: null,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

async function createInvitation({ userId, createdBy = null, sendVia = 'email' }) {
  if (isExternalDataMode()) {
    const err = new Error('Invitations are disabled in external auth mode');
    err.status = 501;
    throw err;
  }

  const user = await db('users').where({ id: userId }).first();
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  if (!user.email) {
    const err = new Error('User has no email — cannot send invitation');
    err.status = 422;
    throw err;
  }

  // Invalidate prior outstanding invitations for this user (one-shot policy).
  await db('user_invitations')
    .where({ user_id: userId, purpose: 'invitation' })
    .whereNull('used_at')
    .update({ used_at: db.fn.now(), send_error: 'superseded' });

  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const [invitation] = await db('user_invitations')
    .insert({
      user_id: userId,
      email: user.email,
      purpose: 'invitation',
      token,
      sent_via: sendVia,
      created_by: createdBy,
      expires_at: expiresAt,
    })
    .returning('*');

  const { subject, text, html } = buildInvitationEmail(user, token);
  const result = await mailer.send({ to: user.email, subject, text, html });

  await db('user_invitations')
    .where({ id: invitation.id })
    .update({
      sent_at: result.status === 'sent' || result.status === 'logged' ? db.fn.now() : null,
      send_error: result.status === 'failed' ? result.error : null,
    });

  return {
    invitation_id: invitation.id,
    user_id: userId,
    email: user.email,
    expires_at: expiresAt.toISOString(),
    delivery: result,
  };
}

async function bulkCreateInvitations({ userIds, createdBy = null }) {
  const out = [];
  for (const id of userIds) {
    try {
      const r = await createInvitation({ userId: id, createdBy });
      out.push({ user_id: id, status: 'ok', delivery: r.delivery });
    } catch (err) {
      out.push({ user_id: id, status: 'error', error: err.message });
    }
  }
  return out;
}

// Find users that are ready to receive an invitation: have a real (non-
// placeholder) email, have never logged in, and currently have no pending
// invitation. Useful right after a roster import: admin sees the list and can
// trigger /bulk on the visible IDs.
async function listPendingUsers({ limit = 200 } = {}) {
  return db('users as u')
    .leftJoin(db.raw(`(
        SELECT user_id FROM user_invitations
         WHERE purpose = 'invitation' AND used_at IS NULL AND expires_at > now()
      ) inv`), 'inv.user_id', 'u.id')
    .select('u.id', 'u.email', 'u.full_name', 'u.role', 'u.is_active', 'u.created_at',
      db.raw('inv.user_id IS NOT NULL AS has_pending_invitation'))
    .where('u.must_change_password', true)
    .whereNull('u.last_login_at')
    .andWhereRaw("u.email NOT LIKE '%@marzam.local'")
    .orderBy('u.created_at', 'desc')
    .limit(limit);
}

async function listInvitations({ pendingOnly = false, limit = 100 } = {}) {
  const q = db('user_invitations as ui')
    .leftJoin('users as u', 'u.id', 'ui.user_id')
    .select(
      'ui.id', 'ui.user_id', 'ui.email', 'ui.purpose', 'ui.sent_via',
      'ui.sent_at', 'ui.expires_at', 'ui.used_at', 'ui.send_error', 'ui.created_at',
      'u.full_name', 'u.role', 'u.is_active',
    )
    .orderBy('ui.created_at', 'desc')
    .limit(limit);
  if (pendingOnly) {
    q.whereNull('ui.used_at').andWhere('ui.expires_at', '>', db.fn.now());
  }
  return q;
}

async function _findActiveToken(token, purpose) {
  const row = await db('user_invitations').where({ token, purpose }).first();
  if (!row) {
    const err = new Error('Token inválido');
    err.status = 404;
    err.code = 'token_not_found';
    throw err;
  }
  if (row.used_at) {
    const err = new Error('Este enlace ya fue utilizado');
    err.status = 410;
    err.code = 'token_used';
    throw err;
  }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    const err = new Error('Este enlace ha expirado');
    err.status = 410;
    err.code = 'token_expired';
    throw err;
  }
  return row;
}

async function validateActivationToken(token) {
  const inv = await _findActiveToken(token, 'invitation');
  const user = await db('users')
    .select('id', 'email', 'full_name', 'role', 'is_active')
    .where({ id: inv.user_id })
    .first();
  return { invitation_id: inv.id, user };
}

async function completeActivation({ token, password }) {
  if (!password || String(password).length < 8) {
    const err = new Error('La contraseña debe tener al menos 8 caracteres');
    err.status = 422;
    err.code = 'password_too_short';
    throw err;
  }
  const inv = await _findActiveToken(token, 'invitation');
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

  return db.transaction(async (trx) => {
    await trx('users')
      .where({ id: inv.user_id })
      .update({
        password_hash,
        is_active: true,
        must_change_password: false,
        updated_at: trx.fn.now(),
      });
    await trx('user_invitations')
      .where({ id: inv.id })
      .update({ used_at: trx.fn.now() });

    const user = await trx('users').where({ id: inv.user_id }).first();
    return user;
  });
}

async function requestPasswordReset({ email }) {
  if (!email) return { ok: true }; // anti-enumeration: silent success
  const user = await db('users').where({ email }).first();
  // Always return ok — don't leak whether the email exists.
  if (!user) return { ok: true };

  const token = newToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);

  // Invalidate any outstanding reset tokens for this user.
  await db('user_invitations')
    .where({ user_id: user.id, purpose: 'password_reset' })
    .whereNull('used_at')
    .update({ used_at: db.fn.now(), send_error: 'superseded' });

  await db('user_invitations').insert({
    user_id: user.id,
    email: user.email,
    purpose: 'password_reset',
    token,
    sent_via: 'email',
    expires_at: expiresAt,
  });

  const { subject, text, html } = buildResetEmail(user, token);
  await mailer.send({ to: user.email, subject, text, html });
  return { ok: true };
}

async function completePasswordReset({ token, password }) {
  if (!password || String(password).length < 8) {
    const err = new Error('La contraseña debe tener al menos 8 caracteres');
    err.status = 422;
    err.code = 'password_too_short';
    throw err;
  }
  const inv = await _findActiveToken(token, 'password_reset');
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

  return db.transaction(async (trx) => {
    await trx('users')
      .where({ id: inv.user_id })
      .update({
        password_hash,
        must_change_password: false,
        updated_at: trx.fn.now(),
      });
    await trx('user_invitations')
      .where({ id: inv.id })
      .update({ used_at: trx.fn.now() });
    return { ok: true };
  });
}

module.exports = {
  createInvitation,
  bulkCreateInvitations,
  listInvitations,
  listPendingUsers,
  validateActivationToken,
  completeActivation,
  requestPasswordReset,
  completePasswordReset,
};
