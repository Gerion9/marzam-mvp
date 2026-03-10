const jwt = require('jsonwebtoken');
const config = require('../config');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = {
      id: payload.id,
      email: payload.email,
      full_name: payload.full_name || null,
      role: payload.role,
      impersonated_by: payload.impersonated_by || null,
      original_role: payload.original_role || null,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authenticate;
