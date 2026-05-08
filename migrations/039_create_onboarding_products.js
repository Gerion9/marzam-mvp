/**
 * pharmacy_onboarding_products — productos que la farmacia ya maneja con su precio
 * actual y el precio que Marzam le ofrece. Sirve para:
 *   - Negociación in situ (rep ve diferencia precio cliente vs Marzam).
 *   - Analítica de margen/ganancia por rep / supervisor / gerente.
 *
 * No hay catálogo SKU todavía — guardamos texto libre + precios. Cuando exista
 * un sync de catálogo, se agrega un FK opcional a products(id).
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('pharmacy_onboarding_products', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('onboarding_id').notNullable().references('id').inTable('pharmacy_onboardings').onDelete('CASCADE');
    t.string('product_name', 200).notNullable();
    t.string('presentation', 120);          // p. ej. "caja 30 tabs", opcional
    t.decimal('price_pharmacy', 12, 2);     // precio actual de la farmacia
    t.decimal('price_marzam', 12, 2);       // precio que Marzam le ofrece
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX idx_onb_prod_onboarding ON pharmacy_onboarding_products (onboarding_id);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pharmacy_onboarding_products');
};
