const LEAD_STATUSES = ['interested', 'follow_up_required', 'contact_captured', 'converted', 'lost'];

const LEAD_TRANSITIONS = {
  interested: ['follow_up_required', 'contact_captured', 'converted', 'lost'],
  follow_up_required: ['contact_captured', 'converted', 'lost'],
  contact_captured: ['converted', 'lost'],
  converted: [],
  lost: ['interested'],
};

function assertLeadTransition(from, to) {
  if (!(LEAD_TRANSITIONS[from] || []).includes(to)) {
    const err = new Error(`Invalid lead transition: ${from} → ${to}`);
    err.status = 422;
    throw err;
  }
}

module.exports = { LEAD_STATUSES, LEAD_TRANSITIONS, assertLeadTransition };
