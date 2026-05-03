/**
 * employee_profiles — RH/HR data kept separate from `users` so PII has its own
 * access guard and a smaller breach surface.
 *
 * Columns mirror the Marzam padron de empleados Excel:
 *   - Domicilio / teléfonos / fechas
 *   - Equipo asignado: IMEI, marca, modelo, status, comentario
 *   - Asignación geográfica: zona_poblaciones, rango, zonas (jsonb)
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('employee_profiles', (t) => {
    t.uuid('user_id').primary().references('id').inTable('users').onDelete('CASCADE');

    t.text('domicilio_particular');
    t.string('telefono_particular', 64);
    t.string('celular', 64);

    t.date('fecha_nacimiento');
    t.date('fecha_ingreso');

    t.string('compania', 128);

    t.string('imei', 64);
    t.string('marca_equipo', 64);
    t.string('modelo_equipo', 128);
    t.string('equipo_status', 64);
    t.text('equipo_comentario');

    t.text('zona_poblaciones');
    t.string('rango', 64);
    t.jsonb('zonas').defaultTo(knex.raw("'[]'::jsonb"));
    t.string('estatus', 32);

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('employee_profiles');
};
