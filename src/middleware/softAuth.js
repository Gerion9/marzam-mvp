const jwt = require('jsonwebtoken');
const config = require('../config');

function softAuth(req, _res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.authUserId = payload.id || null;
  } catch {
    // ignore — full auth middleware will reject if the route needs it
  }
  return next();
}

module.exports = softAuth;
