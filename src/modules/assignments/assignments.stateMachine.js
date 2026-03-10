/**
 * Assignment status state machine.
 *
 * States:
 *   unassigned  → assigned     (manager assigns rep)
 *   assigned    → in_progress  (rep starts working route)
 *   in_progress → completed    (all stops resolved)
 *   assigned    → unassigned   (manager revokes)
 *   in_progress → assigned     (manager pauses / reassigns)
 */

const TRANSITIONS = {
  unassigned:  ['assigned'],
  assigned:    ['in_progress', 'unassigned'],
  in_progress: ['completed', 'assigned'],
  completed:   [],
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const err = new Error(`Invalid status transition: ${from} → ${to}`);
    err.status = 422;
    throw err;
  }
}

module.exports = { TRANSITIONS, canTransition, assertTransition };
