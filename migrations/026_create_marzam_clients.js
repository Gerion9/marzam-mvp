/**
 * marzam_clients — Marzam commercial customer master.
 *
 * Independent from `pharmacies` (BlackPrint POI universe). The match
 * BlackPrint↔Marzam (pharmacy_id link) is performed by the Data team out of
 * band; this column stays nullable until that join lands.
 *
 * Includes:
 *   - PARETO classification (A/B/C) + a trigger that enforces the right
 *     responsible owner is set per class.
 *   - A `client_visit_owner` view that resolves the effective owner per row,
 *     so tracking/visit endpoints can filter by `owner_user_id`.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('marzam_clients', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.string('cpadre', 64).notNullable().unique();
    t.uuid('pharmacy_id').references('id').inTable('pharmacies').onDelete('SET NULL');

    t.string('farmacia_nombre', 500);
    t.string('delegacion_municipio', 255);
    t.string('poblacion', 255);

    t.string('pareto', 1);
    t.string('perfil', 128);

    t.boolean('unefarm').defaultTo(false);
    t.boolean('is_independent').defaultTo(true);
    t.boolean('contact_center').defaultTo(false);

    t.integer('mostradores');
    t.string('cliente_visita', 128);

    t.string('ruta', 128);
    t.date('liberacion_de_ruta');

    t.uuid('assigned_rep_id').references('id').inTable('users').onDelete('SET NULL');
    t.uuid('assigned_supervisor_id').references('id').inTable('users').onDelete('SET NULL');
    t.uuid('assigned_gerente_id').references('id').inTable('users').onDelete('SET NULL');

    t.string('clientes_cc', 128);
    t.text('agente');

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.timestamp('last_imported_at');
  });

  await knex.raw(`
    ALTER TABLE marzam_clients
      ADD CONSTRAINT marzam_clients_pareto_check
      CHECK (pareto IS NULL OR pareto IN ('A', 'B', 'C'));
  `);

  await knex.raw('CREATE INDEX idx_marzam_clients_pareto ON marzam_clients (pareto);');
  await knex.raw('CREATE INDEX idx_marzam_clients_rep ON marzam_clients (assigned_rep_id);');
  await knex.raw('CREATE INDEX idx_marzam_clients_supervisor ON marzam_clients (assigned_supervisor_id);');
  await knex.raw('CREATE INDEX idx_marzam_clients_gerente ON marzam_clients (assigned_gerente_id);');
  await knex.raw('CREATE INDEX idx_marzam_clients_pharmacy ON marzam_clients (pharmacy_id);');
  await knex.raw('CREATE INDEX idx_marzam_clients_pareto_rep ON marzam_clients (pareto, assigned_rep_id);');

  // PARETO ownership enforcement.
  // Pareto A → must have gerente, Pareto B → supervisor, Pareto C → rep.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION enforce_pareto_owner()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.pareto = 'A' AND NEW.assigned_gerente_id IS NULL THEN
        RAISE EXCEPTION 'Pareto A requires assigned_gerente_id (cpadre=%)', NEW.cpadre;
      ELSIF NEW.pareto = 'B' AND NEW.assigned_supervisor_id IS NULL THEN
        RAISE EXCEPTION 'Pareto B requires assigned_supervisor_id (cpadre=%)', NEW.cpadre;
      ELSIF NEW.pareto = 'C' AND NEW.assigned_rep_id IS NULL THEN
        RAISE EXCEPTION 'Pareto C requires assigned_rep_id (cpadre=%)', NEW.cpadre;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    CREATE TRIGGER trg_enforce_pareto_owner
      BEFORE INSERT OR UPDATE ON marzam_clients
      FOR EACH ROW
      EXECUTE FUNCTION enforce_pareto_owner();
  `);

  // Effective visit owner — used to filter "my clients" in tracking/visits.
  await knex.raw(`
    CREATE VIEW client_visit_owner AS
    SELECT
      id AS marzam_client_id,
      pharmacy_id,
      cpadre,
      pareto,
      CASE pareto
        WHEN 'A' THEN assigned_gerente_id
        WHEN 'B' THEN assigned_supervisor_id
        WHEN 'C' THEN assigned_rep_id
      END AS owner_user_id
    FROM marzam_clients;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS client_visit_owner;');
  await knex.raw('DROP TRIGGER IF EXISTS trg_enforce_pareto_owner ON marzam_clients;');
  await knex.raw('DROP FUNCTION IF EXISTS enforce_pareto_owner();');
  await knex.schema.dropTableIfExists('marzam_clients');
};
