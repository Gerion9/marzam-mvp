const knex = require('knex');

const config = require('./index');

let externalDb = null;

function getExternalDatabase() {
  if (externalDb) return externalDb;
  if (!config.externalDb.host || !config.externalDb.database || !config.externalDb.user) {
    const err = new Error('External SQL data source is not configured');
    err.status = 500;
    throw err;
  }

  externalDb = knex({
    client: 'pg',
    connection: {
      host: config.externalDb.host,
      port: config.externalDb.port,
      database: config.externalDb.database,
      user: config.externalDb.user,
      password: config.externalDb.password,
      ssl: config.externalDb.ssl ? { rejectUnauthorized: false } : false,
    },
    pool: { min: 0, max: 10 },
  });

  return externalDb;
}

module.exports = getExternalDatabase;
