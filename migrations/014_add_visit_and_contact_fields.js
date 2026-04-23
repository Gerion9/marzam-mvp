exports.up = async function (knex) {
  await knex.schema.alterTable('visit_reports', (t) => {
    t.text('wholesalers');
    t.text('visit_observations');
    t.text('competition_info');
    t.text('competition_prices');
    t.text('competition_offers');
    t.string('contact_email', 255);
    t.string('contact_name', 255);
  });

  await knex.schema.alterTable('pharmacies', (t) => {
    t.string('contact_email', 255);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('visit_reports', (t) => {
    t.dropColumn('wholesalers');
    t.dropColumn('visit_observations');
    t.dropColumn('competition_info');
    t.dropColumn('competition_prices');
    t.dropColumn('competition_offers');
    t.dropColumn('contact_email');
    t.dropColumn('contact_name');
  });

  await knex.schema.alterTable('pharmacies', (t) => {
    t.dropColumn('contact_email');
  });
};
