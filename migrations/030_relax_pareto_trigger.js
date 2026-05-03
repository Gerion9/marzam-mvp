/**
 * Relax the PARETO trigger.
 *
 * The trigger created in 026 enforced "Pareto A → assigned_gerente_id required"
 * etc. That rule no longer holds: every rank visits pharmacies, the rep is not
 * the only owner, and a Marzam client may be in the catalog before any owner
 * is assigned.
 *
 * Replaced by:
 *   - DROP the trigger and function.
 *   - VIEW `pareto_default_owner` — read-only "suggested owner" used by the UI
 *     as a default but never enforced.
 *
 * `client_visit_owner` (also created in 026) stays as it is — it returns the
 * current owner per row but no longer comes from a trigger.
 */

exports.up = async function up(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS trg_enforce_pareto_owner ON marzam_clients;');
  await knex.raw('DROP FUNCTION IF EXISTS enforce_pareto_owner();');

  await knex.raw(`
    CREATE OR REPLACE VIEW pareto_default_owner AS
    SELECT
      mc.id AS marzam_client_id,
      mc.cpadre,
      mc.pareto,
      CASE mc.pareto
        WHEN 'A' THEN COALESCE(mc.assigned_gerente_id, mc.assigned_supervisor_id, mc.assigned_rep_id)
        WHEN 'B' THEN COALESCE(mc.assigned_supervisor_id, mc.assigned_rep_id, mc.assigned_gerente_id)
        WHEN 'C' THEN COALESCE(mc.assigned_rep_id, mc.assigned_supervisor_id, mc.assigned_gerente_id)
      END AS suggested_owner_user_id
    FROM marzam_clients mc;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS pareto_default_owner;');

  // Recreate the strict trigger from 026.
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
};
