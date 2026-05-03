/**
 * Differentiate farmacias vs consultorios in `pharmacies`, and record the
 * geocoding confidence for Marzam clients.
 *
 *   business_type        TEXT  CHECK (business_type IN ('pharmacy','consultorio'))
 *   geocoded_relevance   NUMERIC(5,4)  — 0.0000..1.0000
 *
 * WHY business_type
 *   The new source of truth for the prospect/client universe is the pair
 *   `staging.stg_marzam_master_scored_{farmacias,consultorios}`.  These
 *   tables share schema; the only thing that distinguishes a farmacia row
 *   from a consultorio row is the source table (and `business_category`,
 *   loosely correlated: pharmacy/drugstore vs doctor/medical_clinic/...).
 *   The FE map needs to render them with different shapes (circle vs
 *   medical cross), so we persist the discriminator explicitly instead of
 *   re-deriving from `business_category` on every query — that text field
 *   has 20+ values and BlackPrint occasionally adds more.
 *
 * WHY geocoded_relevance
 *   Marzam clients (record_type='CLIENT' in master_scored) DO NOT ship
 *   real lat/lng — Marzam hasn't shared their authoritative coordinates
 *   yet.  Instead, BlackPrint geocoded the postal address through a
 *   provider that returns a relevance score in [0,1].  We keep that score
 *   so the rep popup can warn ("Ubicación geocodeada · 87% confianza")
 *   instead of pretending the dot is field-validated.  Prospects already
 *   have lat/lng directly from Dataplor (field-collected) so the column
 *   stays NULL for them — that NULL is itself the "we trust this point"
 *   signal.
 *
 * No index on either column — neither is used as a filter predicate at
 * scale (FE filters by business_type client-side after fetching the full
 * universe via `/api/marzam/universe`).
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pharmacies', (t) => {
    t.string('business_type', 16);
    t.decimal('geocoded_relevance', 5, 4);
  });

  await knex.raw(`
    ALTER TABLE pharmacies
      ADD CONSTRAINT pharmacies_business_type_check
      CHECK (business_type IS NULL OR business_type IN ('pharmacy', 'consultorio'));
  `);

  await knex.raw(`
    ALTER TABLE pharmacies
      ADD CONSTRAINT pharmacies_geocoded_relevance_range
      CHECK (geocoded_relevance IS NULL OR (geocoded_relevance >= 0 AND geocoded_relevance <= 1));
  `);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE pharmacies DROP CONSTRAINT IF EXISTS pharmacies_geocoded_relevance_range;');
  await knex.raw('ALTER TABLE pharmacies DROP CONSTRAINT IF EXISTS pharmacies_business_type_check;');
  await knex.schema.alterTable('pharmacies', (t) => {
    t.dropColumn('geocoded_relevance');
    t.dropColumn('business_type');
  });
};
