/**
 * Fix the visit_reports immutability trigger (mig 090): allow NULL → value
 * transitions so retroactive backfills (e.g. populating
 * client_state_at_visit + marzam_client_id added by mig 088) can run against
 * historical rows even past the 7-day window.
 *
 * The original trigger blocked ANY field difference past 7d. That includes
 * NULL → 'existing', which is what the mig 088 backfill emits. Without this
 * fix, no historical row can be decorated with the new columns, breaking the
 * bonus engine's "existing vs new" split on every visit older than 7d.
 *
 * New rule: a field is "immutable" only when the OLD value is non-NULL AND the
 * NEW value is different. NULL → anything is allowed. Set → set (or set → NULL)
 * is still rejected.
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION marzam_app.visit_reports_immutable_after_7d()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.created_at < NOW() - INTERVAL '7 days' THEN
        IF (OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome)
           OR (OLD.checkin_lat IS NOT NULL AND NEW.checkin_lat IS DISTINCT FROM OLD.checkin_lat)
           OR (OLD.checkin_lng IS NOT NULL AND NEW.checkin_lng IS DISTINCT FROM OLD.checkin_lng)
           OR (OLD.client_state_at_visit IS NOT NULL AND NEW.client_state_at_visit IS DISTINCT FROM OLD.client_state_at_visit)
           OR (OLD.marzam_client_id IS NOT NULL AND NEW.marzam_client_id IS DISTINCT FROM OLD.marzam_client_id)
           OR (OLD.visit_plan_assignment_id IS NOT NULL AND NEW.visit_plan_assignment_id IS DISTINCT FROM OLD.visit_plan_assignment_id)
           OR (OLD.pharmacy_id IS NOT NULL AND NEW.pharmacy_id IS DISTINCT FROM OLD.pharmacy_id)
           OR (OLD.rep_id IS NOT NULL AND NEW.rep_id IS DISTINCT FROM OLD.rep_id)
        THEN
          RAISE EXCEPTION 'visit_reports immutable after 7 days: id=% (field already set, mutation rejected)', OLD.id
            USING ERRCODE = '23000';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
};

exports.down = async function down(knex) {
  // Restore the strict version (mig 090 body).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION marzam_app.visit_reports_immutable_after_7d()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.created_at < NOW() - INTERVAL '7 days' THEN
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
};
