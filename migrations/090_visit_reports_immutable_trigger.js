/**
 * visit_reports immutability trigger — block UPDATEs of critical fields after
 * 7 days. Soft-delete (deleted_at, deleted_by, deletion_reason) is always
 * allowed, but the outcome, GPS checkin, and frozen client state are locked
 * once the record ages out of the "correction window".
 *
 * Why a trigger instead of app-layer guard: the bonus engine + audit queries
 * are external — a misconfigured cron or a manual SQL session could still
 * mutate the row. DB-level enforcement is the only true guarantee.
 *
 * Window: 7 days. Adjustable by env if needed — but baseline is 7d (matches
 * what visit-photo retention assumes).
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION marzam_app.visit_reports_immutable_after_7d()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.created_at < NOW() - INTERVAL '7 days' THEN
        -- Allowed mutations: soft-delete fields + updated_at.
        IF (NEW.outcome IS DISTINCT FROM OLD.outcome)
           OR (NEW.checkin_lat IS DISTINCT FROM OLD.checkin_lat)
           OR (NEW.checkin_lng IS DISTINCT FROM OLD.checkin_lng)
           OR (NEW.client_state_at_visit IS DISTINCT FROM OLD.client_state_at_visit)
           OR (NEW.marzam_client_id IS DISTINCT FROM OLD.marzam_client_id)
           OR (NEW.visit_plan_assignment_id IS DISTINCT FROM OLD.visit_plan_assignment_id)
           OR (NEW.pharmacy_id IS DISTINCT FROM OLD.pharmacy_id)
           OR (NEW.rep_id IS DISTINCT FROM OLD.rep_id)
        THEN
          RAISE EXCEPTION 'visit_reports immutable after 7 days: id=%', OLD.id
            USING ERRCODE = '23000';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_visit_reports_immutable ON visit_reports;
    CREATE TRIGGER trg_visit_reports_immutable
      BEFORE UPDATE ON visit_reports
      FOR EACH ROW EXECUTE FUNCTION marzam_app.visit_reports_immutable_after_7d();
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS trg_visit_reports_immutable ON visit_reports;');
  await knex.raw('DROP FUNCTION IF EXISTS marzam_app.visit_reports_immutable_after_7d();');
};
