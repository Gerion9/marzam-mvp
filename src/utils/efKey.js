/**
 * Entidad Federativa key normalization — shared between backend services and
 * frontend views.js. The frontend copy lives in the renderPlan scope of views.js;
 * this file is the canonical CommonJS version with identical logic.
 *
 * efKey(s): comparison key — lowercase, no accents, collapsed spaces, alias-expanded.
 * Used for Map lookups, Set membership, and filter equality checks.
 *
 * EF_ALIASES: canonical alias map so that "edomex", "cdmx", "df", etc. all
 * resolve to the same key as the full official name.
 */

const EF_ALIASES = Object.freeze({
  'edomex':           'estado de mexico',
  'edo mex':          'estado de mexico',
  'edo. mex.':        'estado de mexico',
  'edo.mex.':         'estado de mexico',
  'estado de mex':    'estado de mexico',
  'estado de mex.':   'estado de mexico',
  'cdmx':             'ciudad de mexico',
  'df':               'ciudad de mexico',
  'd.f.':             'ciudad de mexico',
  'distrito federal': 'ciudad de mexico',
});

function efKey(s) {
  if (s == null) return '';
  const n = String(s).trim().toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
  return EF_ALIASES[n] ?? n;
}

module.exports = { efKey, EF_ALIASES };
