/**
 * Extiende `visit_reports` para capturar pedido y razón cuando NO se concreta.
 * Y crea `visit_products` para precios capturados durante la visita a clientes.
 *
 * Diferencia con onboarding_products:
 *   - onboarding_products → primer alta de farmacia nueva (snapshot inicial).
 *   - visit_products      → cada visita posterior a una farmacia (cliente o nueva)
 *                           para tracking longitudinal de precios y márgenes.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('visit_reports', (t) => {
    t.boolean('order_placed').defaultTo(false);
    t.string('no_order_reason', 64);
    // Razones cerradas (sugeridas en UI; no constraint para evitar friction):
    //   sin_inventario_marzam, precio_alto, no_decision_maker,
    //   cliente_no_estaba, cerrado, sin_interes, otra
    t.decimal('order_amount', 12, 2);
  });

  await knex.schema.createTable('visit_products', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('visit_id').notNullable().references('id').inTable('visit_reports').onDelete('CASCADE');
    t.string('product_name', 200).notNullable();
    t.string('presentation', 120);
    t.decimal('price_pharmacy', 12, 2);
    t.decimal('price_marzam', 12, 2);
    t.boolean('included_in_order').defaultTo(false);
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX idx_visit_products_visit ON visit_products (visit_id);');
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visit_products');
  await knex.schema.alterTable('visit_reports', (t) => {
    t.dropColumn('order_placed');
    t.dropColumn('no_order_reason');
    t.dropColumn('order_amount');
  });
};
