const jwt = require('jsonwebtoken');

const config = require('../../config');

function signVisitToken(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: '24h' });
}

function verifyVisitToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch {
    const err = new Error('Visit token is invalid or expired');
    err.status = 404;
    throw err;
  }
}

module.exports = {
  signVisitToken,
  verifyVisitToken,
};
