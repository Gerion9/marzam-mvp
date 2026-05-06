const db = require('../../config/database');
const {
  assertTransition,
  requiredDocsFor,
  isValidDocType,
} = require('./onboarding.spec');
const { uploadOnboardingDoc } = require('./onboarding.gcs');
const { sendDatamasterNotification } = require('./onboarding.email');

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function err(status, message) { const e = new Error(message); e.status = status; throw e; }

async function getById(id) {
  return db('pharmacy_onboardings').where({ id }).first();
}

async function listMine({ userId, limit = 50, status }) {
  const q = db('pharmacy_onboardings')
    .where({ created_by: userId })
    .orderBy('created_at', 'desc')
    .limit(Math.min(Number(limit) || 50, 200));
  if (status) q.where({ status });
  return q;
}

async function listDocs(onboardingId) {
  return db('pharmacy_onboarding_documents')
    .where({ onboarding_id: onboardingId })
    .orderBy('captured_at', 'asc');
}

async function create({ userId, payload }) {
  const {
    visit_session_id, dataplor_id, not_in_directory,
    persona_tipo, forma_pago,
    rfc, razon_social, nombre_comercial,
    contact_name, contact_phone, contact_email,
    lat, lng, address, notes,
  } = payload || {};

  if (persona_tipo && !['fisica', 'moral'].includes(persona_tipo)) err(422, 'persona_tipo inválido');
  if (forma_pago && !['efectivo', 'credito'].includes(forma_pago)) err(422, 'forma_pago inválida');

  const [row] = await db('pharmacy_onboardings').insert({
    created_by: userId,
    visit_session_id: visit_session_id || null,
    dataplor_id: dataplor_id || null,
    not_in_directory: !!not_in_directory,
    persona_tipo: persona_tipo || null,
    forma_pago: forma_pago || null,
    requires_credit_approval: forma_pago === 'credito',
    rfc: rfc || null,
    razon_social: razon_social || null,
    nombre_comercial: nombre_comercial || null,
    contact_name: contact_name || null,
    contact_phone: contact_phone || null,
    contact_email: contact_email || null,
    lat: lat ?? null,
    lng: lng ?? null,
    address: address || null,
    notes: notes || null,
    status: 'draft',
  }).returning('*');
  return row;
}

async function update({ id, userId, isGlobal, patch }) {
  const row = await getById(id);
  if (!row) err(404, 'Onboarding no encontrado');
  if (!isGlobal && row.created_by !== userId) err(403, 'No puedes editar esta alta');
  if (['approved_cash', 'approved_credit', 'rejected'].includes(row.status)) {
    err(422, 'Esta alta ya fue cerrada y no puede editarse');
  }

  const allowed = [
    'dataplor_id', 'not_in_directory', 'persona_tipo', 'forma_pago',
    'rfc', 'razon_social', 'nombre_comercial',
    'contact_name', 'contact_phone', 'contact_email',
    'lat', 'lng', 'address', 'notes',
  ];
  const update = { updated_at: db.fn.now() };
  for (const k of allowed) if (patch[k] !== undefined) update[k] = patch[k];
  if (patch.forma_pago !== undefined) {
    update.requires_credit_approval = patch.forma_pago === 'credito';
  }
  if (patch.persona_tipo && !['fisica', 'moral'].includes(patch.persona_tipo)) err(422, 'persona_tipo inválido');
  if (patch.forma_pago && !['efectivo', 'credito'].includes(patch.forma_pago)) err(422, 'forma_pago inválida');

  const [updated] = await db('pharmacy_onboardings')
    .where({ id }).update(update).returning('*');
  return updated;
}

async function uploadDoc({ id, userId, isGlobal, docType, file, lat, lng }) {
  if (!isValidDocType(docType)) err(422, `doc_type inválido: ${docType}`);
  if (!file) err(400, 'Falta archivo');
  if (!ALLOWED_MIMES.has(file.mimetype)) err(415, `Tipo de archivo no soportado: ${file.mimetype}`);

  const row = await getById(id);
  if (!row) err(404, 'Onboarding no encontrado');
  if (!isGlobal && row.created_by !== userId) err(403, 'No puedes subir docs a esta alta');
  if (['approved_cash', 'approved_credit', 'rejected'].includes(row.status)) {
    err(422, 'Esta alta ya fue cerrada');
  }

  const { bucket, objectPath, photoUrl } = await uploadOnboardingDoc({
    onboardingId: id,
    docType,
    originalName: file.originalname,
    buffer: file.buffer,
    contentType: file.mimetype,
  });

  // Upsert: si ya había una foto del mismo doc_type para esta alta, la reemplazamos.
  await db('pharmacy_onboarding_documents')
    .where({ onboarding_id: id, doc_type: docType })
    .delete();

  const [doc] = await db('pharmacy_onboarding_documents').insert({
    onboarding_id: id,
    doc_type: docType,
    gcs_bucket: bucket,
    gcs_path: objectPath,
    photo_url: photoUrl,
    content_type: file.mimetype,
    size_bytes: file.size || null,
    captured_lat: lat ?? null,
    captured_lng: lng ?? null,
  }).returning('*');

  await db('pharmacy_onboardings').where({ id }).update({ updated_at: db.fn.now() });
  return doc;
}

async function submit({ id, userId, isGlobal }) {
  const row = await getById(id);
  if (!row) err(404, 'Onboarding no encontrado');
  if (!isGlobal && row.created_by !== userId) err(403, 'No puedes enviar esta alta');

  if (!row.persona_tipo) err(422, 'Falta tipo de persona');
  if (!row.forma_pago) err(422, 'Falta forma de pago');

  const docs = await listDocs(id);
  const required = requiredDocsFor({
    personaTipo: row.persona_tipo,
    notInDirectory: row.not_in_directory,
  });
  const have = new Set(docs.map((d) => d.doc_type));
  const missing = required.filter((r) => !have.has(r.type)).map((r) => r.type);
  if (missing.length) {
    const e = new Error(`Faltan documentos: ${missing.join(', ')}`);
    e.status = 422;
    e.missing = missing;
    throw e;
  }

  assertTransition(row.status, 'submitted');

  const nextStatus = row.requires_credit_approval ? 'pending_credit_review' : 'approved_cash';

  // Snapshot del usuario para el correo (nombre legible).
  const user = await db('users').where({ id: row.created_by }).first();
  const enriched = { ...row, created_by_name: user?.full_name || user?.email || row.created_by };

  // Intentamos enviar correo a datamaster (best-effort).
  const mail = await sendDatamasterNotification(enriched, docs);

  const [updated] = await db('pharmacy_onboardings')
    .where({ id })
    .update({
      status: nextStatus,
      submitted_at: db.fn.now(),
      datamaster_email_status: mail.status,
      datamaster_email_sent_at: mail.status === 'sent' ? db.fn.now() : null,
      datamaster_email_error: mail.error || null,
      updated_at: db.fn.now(),
    })
    .returning('*');

  return { onboarding: updated, mail };
}

async function setCreditDecision({ id, decision, notes, actorId, isGlobal }) {
  if (!['approved', 'rejected'].includes(decision)) err(422, 'decisión inválida');
  const row = await getById(id);
  if (!row) err(404, 'Onboarding no encontrado');
  // Authorization: creator OR a manager up the chain (supervisor / gerente /
  // director) can decide. Admins always pass via isGlobal.
  if (!isGlobal && row.created_by !== actorId) {
    const { canActorManage } = require('../../services/teamScope');
    const canOverride = await canActorManage(actorId, row.created_by);
    if (!canOverride) err(403, 'No puedes decidir crédito en esta alta');
  }
  if (row.status !== 'pending_credit_review') err(422, 'La alta no está en revisión de crédito');

  const next = decision === 'approved' ? 'approved_credit' : 'rejected';
  assertTransition(row.status, next);

  const [updated] = await db('pharmacy_onboardings')
    .where({ id })
    .update({
      status: next,
      credit_decision: decision,
      credit_notes: notes || null,
      updated_at: db.fn.now(),
    })
    .returning('*');
  return updated;
}

/**
 * Candidatos cercanos a una coordenada — solo prospectos NO clientes Marzam.
 * `pharmacies.source = 'blackprint'` ↔ no es cliente Marzam (lo pone syncProspectScored.js).
 */
// ── Productos capturados al alta ──────────────────────────────────────
async function listProducts(onboardingId) {
  return db('pharmacy_onboarding_products')
    .where({ onboarding_id: onboardingId })
    .orderBy('created_at', 'asc');
}

async function addProduct({ onboardingId, userId, isGlobal, payload }) {
  const row = await getById(onboardingId);
  if (!row) err(404, 'Onboarding no encontrado');
  if (!isGlobal && row.created_by !== userId) err(403, 'No puedes editar esta alta');
  const { product_name, presentation, price_pharmacy, price_marzam, notes } = payload || {};
  if (!product_name || !String(product_name).trim()) err(422, 'product_name es requerido');
  const [created] = await db('pharmacy_onboarding_products').insert({
    onboarding_id: onboardingId,
    product_name: String(product_name).trim(),
    presentation: presentation || null,
    price_pharmacy: price_pharmacy != null && price_pharmacy !== '' ? Number(price_pharmacy) : null,
    price_marzam: price_marzam != null && price_marzam !== '' ? Number(price_marzam) : null,
    notes: notes || null,
  }).returning('*');
  return created;
}

async function deleteProduct({ onboardingId, productId, userId, isGlobal }) {
  const row = await getById(onboardingId);
  if (!row) err(404, 'Onboarding no encontrado');
  if (!isGlobal && row.created_by !== userId) err(403, 'No puedes editar esta alta');
  const n = await db('pharmacy_onboarding_products')
    .where({ id: productId, onboarding_id: onboardingId })
    .delete();
  if (!n) err(404, 'Producto no encontrado');
  return { ok: true };
}

async function nearbyNewCandidates({ lat, lng, radiusM = 250, limit = 20 }) {
  if (lat == null || lng == null) {
    err(400, 'Faltan lat/lng');
  }
  const rows = await db.raw(
    `
    SELECT
      id, name, address, municipality, state, source,
      ST_Y(coordinates::geometry) AS lat,
      ST_X(coordinates::geometry) AS lng,
      ST_Distance(coordinates, ST_MakePoint(?, ?)::geography) AS distance_m
    FROM pharmacies
    WHERE coordinates IS NOT NULL
      AND COALESCE(source,'') <> 'marzam'
      AND ST_DWithin(coordinates, ST_MakePoint(?, ?)::geography, ?)
    ORDER BY distance_m ASC
    LIMIT ?
    `,
    [lng, lat, lng, lat, Number(radiusM) || 250, Math.min(Number(limit) || 20, 100)],
  );
  return rows.rows || rows;
}

module.exports = {
  getById,
  listMine,
  listDocs,
  create,
  update,
  uploadDoc,
  submit,
  setCreditDecision,
  nearbyNewCandidates,
  listProducts,
  addProduct,
  deleteProduct,
};
