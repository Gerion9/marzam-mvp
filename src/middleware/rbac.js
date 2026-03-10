/**
 * Returns middleware that restricts access to the listed roles.
 * Must be placed AFTER the authenticate middleware so req.user exists.
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

module.exports = authorize;
