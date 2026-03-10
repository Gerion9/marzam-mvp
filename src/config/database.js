const knex = require('knex');
const knexConfig = require('../../knexfile');
const config = require('./index');

const environment = config.env === 'production' ? 'production' : 'development';
const db = knex(knexConfig[environment]);

module.exports = db;
