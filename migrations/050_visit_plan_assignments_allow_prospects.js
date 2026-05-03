/**
 * Permite que `visit_plan_assignments` apunte a una farmacia PROSPECTO
 * (`pharmacies.id`) en vez de un cliente Marzam (`marzam_clients.id`).
 *
 * MOTIVACIÓN
 * ----------
 * Hasta migración 035 el plan generator solo podía asignar farmacias del
 * universo `marzam_clients` (clientes que ya facturan).  Las farmacias
 * "nuevas" (prospectos en `pharmacies` con `source <> 'marzam'`) quedaban
 * fuera del plan: solo se contaban *después* del hecho en Distribución.
 *
 * Regla de negocio acordada (Apr-30):
 *   "A las farmacias nuevas se les considera como PARETO C — las visitan
 *    representantes y supervisores, pero no gerentes ni director."
 *
 * Esa regla ya casa con `ROLE_PRIMARY_PARETO` del planGenerator (el bucket
 * 'C' incluye supervisor + representante), así que solo necesitamos abrir
 * el schema para que el generator pueda materializar prospectos como filas
 * del plan.
 *
 * QUÉ CAMBIA
 * ----------
 *   1) `marzam_client_id` pasa a NULLABLE.
 *   2) Se agrega `pharmacy_id UUID NULL REFERENCES pharmacies(id)`.
 *   3) Constraint XOR — exactamente UNO de los dos targets debe estar set.
 *      Esto previene filas ambiguas y deja la semántica explícita:
 *        - cliente Marzam     → marzam_client_id NOT NULL, pharmacy_id NULL
 *        - prospecto BlackPrint → pharmacy_id NOT NULL,    marzam_client_id NULL
 *   4) El UNIQUE índice se reconstruye sobre la "target key" coalescida.
 *
 * Impacto en lecturas: los servicios que leen assignments deben hacer
 * `LEFT JOIN pharmacies` adicional para resolver el caso prospecto.  Ver
 * `visitPlans.service.js` post-migración 050.
 */

exports.up = async function up(knex) {
  // 1) El UNIQUE viejo asume marzam_client_id NOT NULL — hay que tirarlo
  //    antes de relajar la columna.
  await knex.raw('DROP INDEX IF EXISTS idx_vpa_unique_per_plan;');

  // 2) Relajar marzam_client_id a nullable.
  await knex.raw('ALTER TABLE visit_plan_assignments ALTER COLUMN marzam_client_id DROP NOT NULL;');

  // 3) Nueva columna pharmacy_id (FK a pharmacies).
  await knex.schema.alterTable('visit_plan_assignments', (t) => {
    t.uuid('pharmacy_id').references('id').inTable('pharmacies').onDelete('CASCADE');
  });

  // 4) XOR constraint — exactamente uno de los dos targets debe estar set.
  await knex.raw(`
    ALTER TABLE visit_plan_assignments
      ADD CONSTRAINT vpa_target_xor_check
      CHECK (
        (marzam_client_id IS NOT NULL AND pharmacy_id IS NULL)
        OR (marzam_client_id IS NULL AND pharmacy_id IS NOT NULL)
      );
  `);

  // 5) Reconstruir el UNIQUE para que cubra ambos tipos de target.
  //    Usamos COALESCE con un UUID centinela para que NULL no rompa el unique.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_vpa_unique_per_plan
      ON visit_plan_assignments (
        visit_plan_id,
        visitor_user_id,
        scheduled_date,
        COALESCE(marzam_client_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(pharmacy_id,      '00000000-0000-0000-0000-000000000000'::uuid)
      );
  `);

  // 6) Índice parcial sobre pharmacy_id para los joins de prospectos.
  await knex.raw(`
    CREATE INDEX idx_vpa_pharmacy
      ON visit_plan_assignments (pharmacy_id)
      WHERE pharmacy_id IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_vpa_pharmacy;');
  await knex.raw('DROP INDEX IF EXISTS idx_vpa_unique_per_plan;');
  await knex.raw('ALTER TABLE visit_plan_assignments DROP CONSTRAINT IF EXISTS vpa_target_xor_check;');

  // Si hay prospectos asignados, tirarlos antes de volver a NOT NULL.
  await knex.raw('DELETE FROM visit_plan_assignments WHERE pharmacy_id IS NOT NULL;');

  await knex.schema.alterTable('visit_plan_assignments', (t) => {
    t.dropColumn('pharmacy_id');
  });
  await knex.raw('ALTER TABLE visit_plan_assignments ALTER COLUMN marzam_client_id SET NOT NULL;');
  await knex.raw(`
    CREATE UNIQUE INDEX idx_vpa_unique_per_plan
      ON visit_plan_assignments (visit_plan_id, visitor_user_id, scheduled_date, marzam_client_id);
  `);
};
