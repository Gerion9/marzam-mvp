/**
 * Generic mail sender, shared by onboarding notifications and user
 * invitations / password resets.
 *
 * Backends in order of preference:
 *   1) SendGrid REST API   — SENDGRID_API_KEY
 *   2) SMTP (nodemailer)   — SMTP_HOST + creds (nodemailer is optional)
 *   3) Console fallback    — only when MAIL_FALLBACK_LOG=true (dev/CI), so a
 *      missing provider doesn't silently fail in production.
 *
 * Returns: `{ status: 'sent'|'failed'|'logged', provider, error }`.
 * Never throws — callers branch on `status` and may persist the failure.
 */

function getFrom() {
  return (process.env.MARZAM_MAIL_FROM || 'no-reply@marzam.mx').trim();
}

function appBaseUrl() {
  return (process.env.PUBLIC_APP_URL || 'https://app.marzam.mx').replace(/\/+$/, '');
}

async function sendViaSendgrid({ to, from, subject, text, html }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return null;
  const content = [{ type: 'text/plain', value: text }];
  if (html) content.push({ type: 'text/html', value: html });
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sendgrid ${res.status}: ${body.slice(0, 300)}`);
  }
  return 'sendgrid';
}

async function sendViaSmtp({ to, from, subject, text, html }) {
  if (!process.env.SMTP_HOST) return null;
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch { return null; }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  await transporter.sendMail({ from, to, subject, text, html });
  return 'smtp';
}

async function send({ to, subject, text, html, from }) {
  if (!to) return { status: 'failed', provider: null, error: 'missing_to' };
  const fromAddr = (from || getFrom()).trim();
  try {
    const provider =
      (await sendViaSendgrid({ to, from: fromAddr, subject, text, html })) ||
      (await sendViaSmtp({ to, from: fromAddr, subject, text, html }));
    if (provider) return { status: 'sent', provider, error: null };
    if (process.env.MAIL_FALLBACK_LOG === 'true') {
      // eslint-disable-next-line no-console
      console.log(`[mailer:console] to=${to} subject=${subject}\n${text}`);
      return { status: 'logged', provider: 'console', error: null };
    }
    return { status: 'failed', provider: null, error: 'no_provider' };
  } catch (err) {
    return { status: 'failed', provider: null, error: err.message || String(err) };
  }
}

module.exports = { send, getFrom, appBaseUrl };
