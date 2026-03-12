const config = require('../../config');
const { getDataScope } = require('../../middleware/requestContext');

function getFieldSurveyTable() {
  return getDataScope() === 'demo'
    ? config.externalData.fieldSurveyTableDemo
    : config.externalData.fieldSurveyTable;
}

function getDeviceLocationsTable() {
  return getDataScope() === 'demo'
    ? config.externalData.deviceLocationsTableDemo
    : config.externalData.deviceLocationsTable;
}

module.exports = { getFieldSurveyTable, getDeviceLocationsTable };
