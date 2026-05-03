/**
 * Envío del aviso a datamaster@marzam.com.mx (correo configurable vía DATAMASTER_EMAIL).
 *
 * Estrategia "best effort": si no hay credenciales SMTP/SendGrid configuradas,
 * NO se intenta enviar — se marca el onboarding como `failed` con motivo
 * "no_provider" para que un job posterior o el admin lo reprocesen.
 *
 * Backends soportados (en orden de preferencia):
 *   1. SendGrid REST API   — SENDGRID_API_KEY
 *   2. SMTP (nodemailer)   — SMTP_HOST + SMTP_USER + SMTP_PASS  (solo si nodemailer
 *                            está instalado; si no, se omite silenciosamente)
 *
 * No agregamos nodemailer como dependencia obligatoria; el require va en try/catch.
 */

const DEFAULT_TO = 'datamaster@marzam.com.mx';

function getRecipient() {
  return (process.env.DATAMASTER_EMAIL || DEFAULT_TO).trim();
}

function getFrom() {
  return (process.env.MARZAM_MAIL_FROM || 'no-reply@marzam.mx').trim();
}

function buildSubject(o) {
  const nombre = o.nombre_comercial || o.razon_social || 'Farmacia nueva';
  return `[Alta nueva] ${nombre} — ${o.persona_tipo || 'persona'} — ${o.forma_pago || ''}`;
}

function buildBody(o, docs = []) {
  const lines = [
    `Se levantó una nueva alta de farmacia desde la app Marzam.`,
    ``,
    `ID interno:        ${o.id}`,
    `Levantada por:     ${o.created_by_name || o.created_by}`,
    `Tipo de persona:   ${o.persona_tipo || '-'}`,
    `Forma de pago:     ${o.forma_pago || '-'}${o.requires_credit_approval ? '  (REQUIERE APROBACIÓN DE CRÉDITO)' : ''}`,
    `RFC:               ${o.rfc || '-'}`,
    `Razón social:      ${o.razon_social || '-'}`,
    `Nombre comercial:  ${o.nombre_comercial || '-'}`,
    `Contacto:          ${o.contact_name || '-'} · ${o.contact_phone || '-'} · ${o.contact_email || '-'}`,
    `Dirección:         ${o.address || '-'}`,
    `Coordenadas:       ${o.lat || '-'}, ${o.lng || '-'}`,
    `Vinculación:       ${o.dataplor_id ? `prospect_scored ${o.dataplor_id}` : (o.not_in_directory ? 'NO ESTABA EN DIRECTORIO' : 'sin vincular')}`,
    ``,
    `Documentos adjuntos (${docs.length}):`,
    ...docs.map((d) => `  - ${d.doc_type}: ${d.photo_url || d.gcs_path || '(sin URL)'}`),
    ``,
    o.notes ? `Notas: ${o.notes}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

async function sendViaSendgrid({ to, from, subject, text }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return null;
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
      content: [{ type: 'text/plain', value: text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sendgrid ${res.status}: ${body.slice(0, 300)}`);
  }
  return 'sendgrid';
}

async function sendViaSmtp({ to, from, subject, text }) {
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
  await transporter.sendMail({ from, to, subject, text });
  return 'smtp';
}

async function sendDatamasterNotification(onboarding, docs = []) {
  const to = getRecipient();
  const from = getFrom();
  const subject = buildSubject(onboarding);
  const text = buildBody(onboarding, docs);

  try {
    const provider =
      (await sendViaSendgrid({ to, from, subject, text })) ||
      (await sendViaSmtp({ to, from, subject, text }));

    if (!provider) {
      return { status: 'failed', error: 'no_provider', provider: null };
    }
    return { status: 'sent', error: null, provider };
  } catch (err) {
    return { status: 'failed', error: err.message || String(err), provider: null };
  }
}

module.exports = {
  sendDatamasterNotification,
  getRecipient,
};
