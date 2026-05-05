/**
 * Visit cadence constants — shared between backend estimation logic and
 * the frontend views.js. How many times per month each category should
 * ideally be visited.
 *
 * Marzam A/B/C are existing clients classified by the standard Marzam
 * Pareto model. Nuevas A/B/C/D are prospects mapped from pharmacies.quadrant_derived
 * (Q1→A, Q2→B, Q3→C, Q4→D) — cosmetic mapping only, no DB migration needed.
 */

/** Monthly visit cadence targets per pareto/category letter. */
const CADENCE_PER_PARETO = Object.freeze({
  A: 4,   // Marzam top / Q1 prospects — weekly
  B: 2,   // Marzam mid / Q2 prospects — bi-weekly
  C: 1,   // Marzam low / Q3 prospects — monthly
  D: 0.5, // Q4 prospects — every 2 months
});

/** Pareto classes for existing Marzam clients. */
const MARZAM_PARETOS = Object.freeze(['A', 'B', 'C']);

/** Category letters for new prospects (mapped from quadrant_derived). */
const PROSPECTO_PARETOS = Object.freeze(['A', 'B', 'C', 'D']);

/** All category letters (union). */
const ALL_PARETOS = Object.freeze(['A', 'B', 'C', 'D']);

/** Map from pharmacies.quadrant_derived to display/category letter. */
const QUADRANT_TO_PARETO = Object.freeze({
  Q1: 'A',
  Q2: 'B',
  Q3: 'C',
  Q4: 'D',
});

/** Reverse mapping (category letter → quadrant). */
const PARETO_TO_QUADRANT = Object.freeze({
  A: 'Q1',
  B: 'Q2',
  C: 'Q3',
  D: 'Q4',
});

/**
 * The 7 ordered columns in the expanded matrix:
 * [marzam/A, marzam/B, marzam/C, prospecto/A, prospecto/B, prospecto/C, prospecto/D]
 */
const MATRIX_COLUMNS = Object.freeze([
  { category_kind: 'marzam',    pareto_class: 'A' },
  { category_kind: 'marzam',    pareto_class: 'B' },
  { category_kind: 'marzam',    pareto_class: 'C' },
  { category_kind: 'prospecto', pareto_class: 'A' },
  { category_kind: 'prospecto', pareto_class: 'B' },
  { category_kind: 'prospecto', pareto_class: 'C' },
  { category_kind: 'prospecto', pareto_class: 'D' },
]);

/** Roles that can prospect (visit non-marzam pharmacies). */
const ROLES_THAT_PROSPECT = Object.freeze(new Set(['supervisor', 'representante']));

module.exports = {
  CADENCE_PER_PARETO,
  MARZAM_PARETOS,
  PROSPECTO_PARETOS,
  ALL_PARETOS,
  QUADRANT_TO_PARETO,
  PARETO_TO_QUADRANT,
  MATRIX_COLUMNS,
  ROLES_THAT_PROSPECT,
};
