const { BigQuery } = require('@google-cloud/bigquery');

const config = require('../../config');

let client = null;

function getBigQueryClient() {
  if (client) return client;
  if (!config.bigquery.serviceAccount) {
    const err = new Error('BQ_SERVICE_ACCOUNT_JSON is not configured');
    err.status = 500;
    throw err;
  }

  const credentials = config.bigquery.serviceAccount;
  client = new BigQuery({
    projectId: config.bigquery.projectId || credentials.project_id,
    credentials,
  });
  return client;
}

module.exports = getBigQueryClient;
