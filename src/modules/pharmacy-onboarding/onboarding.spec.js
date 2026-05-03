/**
 * Spec única para el wizard de "alta de farmacia nueva".
 *
 * Tanto el backend (validación) como el frontend (steps dinámicos) deben
 * leer de aquí — si un día se agrega un documento, se cambia en un solo lugar.
 */

const STATUSES = [
  'draft',
  'docs_uploaded',
  'submitted',
  'approved_cash',
  'pending_credit_review',
  'approved_credit',
  'rejected',
];

const TRANSITIONS = {
  draft: ['docs_uploaded', 'submitted'],
  docs_uploaded: ['submitted', 'draft'],
  submitted: ['approved_cash', 'pending_credit_review', 'rejected'],
  pending_credit_review: ['approved_credit', 'rejected'],
  approved_cash: [],
  approved_credit: [],
  rejected: ['draft'],
};

function assertTransition(from, to) {
  if (!(TRANSITIONS[from] || []).includes(to)) {
    const err = new Error(`Invalid onboarding transition: ${from} → ${to}`);
    err.status = 422;
    throw err;
  }
}

// Documentos legales por tipo de persona.
const DOCS_FISICA = [
  { type: 'constancia_fiscal',     label: 'Constancia de Situación Fiscal' },
  { type: 'comprobante_domicilio', label: 'Comprobante de Domicilio' },
  { type: 'ine',                   label: 'INE' },
];

const DOCS_MORAL = [
  ...DOCS_FISICA,
  { type: 'acta_constitutiva',     label: 'Acta Constitutiva' },
  { type: 'poder_legal',           label: 'Poder del Representante Legal' },
];

// Fotos de fachada — caso "sí existe la farmacia"
const FACADE_FOUND = [
  { type: 'facade_front', label: 'Fachada (frente)' },
];

// Fotos cuando el rep dice "no está aquí" — bloqueo duro: 3 fotos.
const FACADE_NOT_FOUND = [
  { type: 'facade_no_exists_left',  label: 'Foto a tu izquierda' },
  { type: 'facade_no_exists_front', label: 'Foto al frente' },
  { type: 'facade_no_exists_right', label: 'Foto a tu derecha' },
];

const ALL_DOC_TYPES = new Set([
  ...DOCS_MORAL.map((d) => d.type),
  ...FACADE_FOUND.map((d) => d.type),
  ...FACADE_NOT_FOUND.map((d) => d.type),
]);

function legalDocsFor(personaTipo) {
  if (personaTipo === 'moral') return DOCS_MORAL;
  return DOCS_FISICA;
}

function facadeDocsFor(notInDirectory) {
  return notInDirectory ? FACADE_NOT_FOUND : FACADE_FOUND;
}

function requiredDocsFor({ personaTipo, notInDirectory }) {
  return [...facadeDocsFor(notInDirectory), ...legalDocsFor(personaTipo)];
}

function isValidDocType(type) {
  return ALL_DOC_TYPES.has(type);
}

const ALLOWED_ROLES = ['supervisor', 'representante'];

module.exports = {
  STATUSES,
  TRANSITIONS,
  assertTransition,
  DOCS_FISICA,
  DOCS_MORAL,
  FACADE_FOUND,
  FACADE_NOT_FOUND,
  legalDocsFor,
  facadeDocsFor,
  requiredDocsFor,
  isValidDocType,
  ALLOWED_ROLES,
};
