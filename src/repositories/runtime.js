const config = require('../config');

function isExternalDataMode() {
  return config.dataBackend !== 'local';
}

module.exports = {
  isExternalDataMode,
};
