/**
 * Pharmacy visit outcome values.
 * Not a traditional state machine — these are terminal outcomes per visit,
 * but some trigger side-effects (lead creation, follow-up scheduling, review queue).
 */

const VISIT_OUTCOMES = [
  'visited',
  'contact_made',
  'interested',
  'not_interested',
  'needs_follow_up',
  'closed',
  'invalid',
  'duplicate',
  'moved',
  'wrong_category',
  'chain_not_independent',
];

const OUTCOMES_REQUIRING_REASON = [
  'closed',
  'invalid',
  'moved',
  'wrong_category',
  'chain_not_independent',
];

const OUTCOMES_CREATING_LEAD = ['interested'];

const OUTCOMES_REQUIRING_FOLLOWUP = ['needs_follow_up'];

const OUTCOMES_CREATING_FLAG = [
  'duplicate',
  'closed',
  'moved',
  'wrong_category',
  'chain_not_independent',
  'invalid',
];

const OUTCOMES_SKIPPING_STOP = [
  'duplicate',
  'closed',
  'moved',
  'wrong_category',
  'chain_not_independent',
  'invalid',
];

function validateOutcome(outcome) {
  if (!VISIT_OUTCOMES.includes(outcome)) {
    const err = new Error(`Invalid visit outcome: ${outcome}`);
    err.status = 422;
    throw err;
  }
}

module.exports = {
  VISIT_OUTCOMES,
  OUTCOMES_REQUIRING_REASON,
  OUTCOMES_CREATING_LEAD,
  OUTCOMES_REQUIRING_FOLLOWUP,
  OUTCOMES_CREATING_FLAG,
  OUTCOMES_SKIPPING_STOP,
  validateOutcome,
};
