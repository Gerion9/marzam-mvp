/**
 * Lightweight request-body validator.
 *
 * Backward-compatible with the original 3-rule schema (required / type / oneOf);
 * the [S8] audit extended it with format checks, length/range bounds, regex
 * pattern matching, and recursive array/object validation — all without adding
 * a third-party dependency.
 *
 * Supported rule keys per field:
 *   required          boolean
 *   type              'string' | 'number' | 'boolean' | 'object' | 'array'
 *   format            'email' | 'url' | 'uuid'
 *   oneOf             any[]
 *   minLength         number  (string only)
 *   maxLength         number  (string only)
 *   min               number  (number only — inclusive)
 *   max               number  (number only — inclusive)
 *   pattern           RegExp  (string only)
 *   items             schema  (array element schema; the same rule shape)
 *   properties        object  (object children schema map — recursive)
 *
 * The validator never throws; on any rule violation it returns 400 with
 * { errors: [...] } where each entry is a human-readable message. Field
 * paths are dot-joined so frontends can map errors back to inputs.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const URL_RE = /^https?:\/\/[^\s]+$/i;

function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkFormat(value, format) {
  if (typeof value !== 'string') return null;
  if (format === 'email' && !EMAIL_RE.test(value)) return 'must be a valid email address';
  if (format === 'uuid' && !UUID_RE.test(value)) return 'must be a valid UUID';
  if (format === 'url' && !URL_RE.test(value)) return 'must be an http(s) URL';
  return null;
}

function validateValue(value, rules, fieldPath, errors) {
  // Required vs present
  const isAbsent = value === undefined || value === null || value === '';
  if (rules.required && isAbsent) {
    errors.push(fieldPath + ' is required');
    return;
  }
  if (isAbsent) return;

  // Type
  if (rules.type) {
    const at = actualType(value);
    if (at !== rules.type) {
      errors.push(fieldPath + ' must be of type ' + rules.type + ' (got ' + at + ')');
      return;
    }
  }

  // String-specific checks
  if (typeof value === 'string') {
    if (rules.format) {
      const msg = checkFormat(value, rules.format);
      if (msg) errors.push(fieldPath + ' ' + msg);
    }
    if (typeof rules.minLength === 'number' && value.length < rules.minLength) {
      errors.push(fieldPath + ' must be at least ' + rules.minLength + ' chars');
    }
    if (typeof rules.maxLength === 'number' && value.length > rules.maxLength) {
      errors.push(fieldPath + ' must be at most ' + rules.maxLength + ' chars');
    }
    if (rules.pattern instanceof RegExp && !rules.pattern.test(value)) {
      errors.push(fieldPath + ' does not match required pattern');
    }
  }

  // Number-specific checks
  if (typeof value === 'number') {
    if (typeof rules.min === 'number' && value < rules.min) {
      errors.push(fieldPath + ' must be >= ' + rules.min);
    }
    if (typeof rules.max === 'number' && value > rules.max) {
      errors.push(fieldPath + ' must be <= ' + rules.max);
    }
  }

  // Enumerable
  if (Array.isArray(rules.oneOf) && !rules.oneOf.includes(value)) {
    errors.push(fieldPath + ' must be one of: ' + rules.oneOf.join(', '));
  }

  // Recursive: array items
  if (Array.isArray(value) && rules.items) {
    // Hard cap on array length to avoid pathological payloads under deep nesting.
    if (typeof rules.maxLength === 'number' && value.length > rules.maxLength) {
      errors.push(fieldPath + ' has too many items (max ' + rules.maxLength + ')');
    }
    value.forEach((item, idx) => {
      validateValue(item, rules.items, fieldPath + '[' + idx + ']', errors);
    });
  }

  // Recursive: object properties
  if (rules.properties && actualType(value) === 'object') {
    for (const [child, childRules] of Object.entries(rules.properties)) {
      validateValue(value[child], childRules, fieldPath + '.' + child, errors);
    }
  }
}

function validate(schema) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rules] of Object.entries(schema)) {
      validateValue(req.body ? req.body[field] : undefined, rules, field, errors);
    }
    if (errors.length) {
      return res.status(400).json({ errors });
    }
    next();
  };
}

module.exports = validate;
// Exposed for unit testing the rule engine in isolation.
module.exports.validateValue = validateValue;
