/**
 * pharmacy_onboardings — Alta de farmacia nueva (no cliente Marzam todavía).
 *
 * Flujo:
 *   draft → docs_uploaded → submitted → (approved_cash | pending_credit_review)
 *   pending_credit_review → (approved_credit | rejected)
 *
 * Reglas:
 * - Solo supervisor / representante pueden crear (gate en routes).
 * - Persona física: 3 docs (constancia_fiscal, comprobante_domicilio, ine).
 * - Persona moral:   5 docs (los 3 de física + acta_constitutiva, poder_legal).
 * - Si "no existe en directorio" se exigen 3 fotos de fachada (left/front/right).
 * - Forma de pago = credito → requires_credit_approval = true.
 * - Al submit se intenta enviar correo a DATAMASTER_EMAIL (best-effort);
 *   el resultado queda en datamaster_email_status para reintentos.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('pharmacy_onboardings', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('created_by').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('visit_session_id').references('id').inTable('visit_sessions').onDelete('SET NULL');

    t.string('status', 32).notNullable().defaultTo('draft');

    // Origen / vinculación con prospect_scored
    t.string('dataplor_id', 64);
    t.boolean('not_in_directory').defaultTo(false);

    // Tipo persona / pago
    t.string('persona_tipo', 16);     // fisica | moral
    t.string('forma_pago', 16);       // efectivo | credito
    t.boolean('requires_credit_approval').defaultTo(false);
    t.string('credit_decision', 16);  // approved | rejected
    t.text('credit_notes');

    // Datos básicos del establecimiento
    t.string('rfc', 20);
    t.string('razon_social', 255);
    t.string('nombre_comercial', 255);
    t.string('contact_name', 255);
    t.string('contact_phone', 32);
    t.string('contact_email', 255);

    // Geo
    t.decimal('lat', 10, 7);
    t.decimal('lng', 10, 7);
    t.text('address');

    // Estado del envío a datamaster@
    t.string('datamaster_email_status', 16).defaultTo('pending');
    t.timestamp('datamaster_email_sent_at');
    t.text('datamaster_email_error');

    t.text('notes');
    t.timestamp('submitted_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE pharmacy_onboardings
      ADD CONSTRAINT pharmacy_onboardings_status_check
      CHECK (status IN (
        'draft','docs_uploaded','submitted',
        'approved_cash','pending_credit_review',
        'approved_credit','rejected'
      ));
  `);
  await knex.raw(`
    ALTER TABLE pharmacy_onboardings
      ADD CONSTRAINT pharmacy_onboardings_persona_check
      CHECK (persona_tipo IS NULL OR persona_tipo IN ('fisica','moral'));
  `);
  await knex.raw(`
    ALTER TABLE pharmacy_onboardings
      ADD CONSTRAINT pharmacy_onboardings_pago_check
      CHECK (forma_pago IS NULL OR forma_pago IN ('efectivo','credito'));
  `);
  await knex.raw('CREATE INDEX idx_pharmacy_onboardings_user ON pharmacy_onboardings (created_by, created_at DESC);');
  await knex.raw('CREATE INDEX idx_pharmacy_onboardings_status ON pharmacy_onboardings (status);');

  await knex.schema.createTable('pharmacy_onboarding_documents', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('onboarding_id').notNullable().references('id').inTable('pharmacy_onboardings').onDelete('CASCADE');
    t.string('doc_type', 48).notNullable();
    t.string('gcs_bucket', 128);
    t.string('gcs_path', 512);
    t.string('photo_url', 1024);
    t.string('content_type', 64);
    t.integer('size_bytes');
    t.decimal('captured_lat', 10, 7);
    t.decimal('captured_lng', 10, 7);
    t.timestamp('captured_at').defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX idx_onb_docs_onboarding ON pharmacy_onboarding_documents (onboarding_id);');
  await knex.raw(`
    CREATE UNIQUE INDEX idx_onb_docs_onboarding_type
      ON pharmacy_onboarding_documents (onboarding_id, doc_type);
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pharmacy_onboarding_documents');
  await knex.schema.dropTableIfExists('pharmacy_onboardings');
};
