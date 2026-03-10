/**
 * Lightweight request-body validator.
 * `schema` is an object whose keys are field names and values are
 * { required?: boolean, type?: string, oneOf?: any[] }.
 *
 * For the MVP this avoids pulling in a heavy validation library.
 */
function validate(schema) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];

      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        continue;
      }

      if (value !== undefined && value !== null) {
        if (rules.type) {
          const actual = Array.isArray(value) ? 'array' : typeof value;
          if (actual !== rules.type) {
            errors.push(`${field} must be of type ${rules.type}`);
          }
        }
        if (rules.oneOf && !rules.oneOf.includes(value)) {
          errors.push(`${field} must be one of: ${rules.oneOf.join(', ')}`);
        }
      }
    }

    if (errors.length) {
      return res.status(400).json({ errors });
    }
    next();
  };
}

module.exports = validate;
