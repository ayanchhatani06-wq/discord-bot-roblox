const TASK_STATES = Object.freeze({
  UNASSIGNED: 'unassigned',
  OFFERED: 'offered',
  IN_PROGRESS: 'in_progress',
  INTERNAL_REVIEW: 'internal_review',
  AWAITING_CLIENT: 'awaiting_client',
  CLIENT_APPROVED: 'client_approved',
  REVISION_NEEDED: 'revision_needed',
  ON_HOLD: 'on_hold',
  CANCELLED: 'cancelled',
});

const STATE_LABELS = Object.freeze({
  unassigned: 'Unassigned',
  offered: 'Offered',
  in_progress: 'In Progress',
  internal_review: 'Internal Review',
  awaiting_client: 'Awaiting Client Approval',
  client_approved: 'Client Approved',
  revision_needed: 'Revision Needed',
  on_hold: 'On Hold',
  cancelled: 'Cancelled',
});

const S = TASK_STATES;

/**
 * Every legal move a task can make, and who is allowed to make it.
 *
 * `actor` values other than 'capability' are checked against the task itself:
 * 'assigned_artist' means only the artist currently holding the task, which is
 * how an artist accepting their own offer is authorised without granting them a
 * capability that would let them act on anybody else's work.
 */
const TRANSITIONS = Object.freeze({
  offer: {
    from: [S.UNASSIGNED],
    to: S.OFFERED,
    capability: 'task.offer',
    departmentScoped: true,
    requires: ['pay_approved', 'artist_selected'],
  },
  offer_accept: {
    from: [S.OFFERED],
    to: S.IN_PROGRESS,
    actor: 'offered_artist',
  },
  offer_decline: {
    from: [S.OFFERED],
    to: S.UNASSIGNED,
    actor: 'offered_artist',
    requires: ['decline_reason'],
  },
  offer_withdraw: {
    from: [S.OFFERED],
    to: S.UNASSIGNED,
    capability: 'task.offer',
    departmentScoped: true,
  },
  offer_expire: {
    from: [S.OFFERED],
    to: S.UNASSIGNED,
    actor: 'system',
  },
  submit_final: {
    from: [S.IN_PROGRESS, S.REVISION_NEEDED],
    to: S.INTERNAL_REVIEW,
    actor: 'assigned_artist',
    requires: ['checklist_complete'],
  },
  review_request_changes: {
    from: [S.INTERNAL_REVIEW],
    to: S.REVISION_NEEDED,
    capability: 'review.internal',
    departmentScoped: true,
    requires: ['review_notes'],
  },
  review_ready_for_client: {
    from: [S.INTERNAL_REVIEW],
    to: S.AWAITING_CLIENT,
    capability: 'review.internal',
    departmentScoped: true,
  },
  client_approve: {
    from: [S.AWAITING_CLIENT],
    to: S.CLIENT_APPROVED,
    capability: 'client.record',
  },
  client_request_revisions: {
    from: [S.AWAITING_CLIENT],
    to: S.REVISION_NEEDED,
    capability: 'client.record',
    requires: ['client_feedback'],
  },
  // A client changing their mind after sign-off is recorded, not hidden, and is
  // flagged so the owner can decide whether it is in scope or a new paid task.
  client_reopen: {
    from: [S.CLIENT_APPROVED],
    to: S.REVISION_NEEDED,
    capability: 'client.record',
    requires: ['client_feedback'],
    flags: ['scope_review'],
  },
  reassign: {
    from: [S.OFFERED, S.IN_PROGRESS, S.INTERNAL_REVIEW, S.REVISION_NEEDED, S.ON_HOLD],
    to: S.OFFERED,
    capability: 'task.reassign',
    departmentScoped: true,
    requires: ['reassign_reason', 'artist_selected'],
    flags: ['compensation_review'],
  },
  hold: {
    from: [S.UNASSIGNED, S.OFFERED, S.IN_PROGRESS, S.INTERNAL_REVIEW, S.AWAITING_CLIENT, S.REVISION_NEEDED],
    to: S.ON_HOLD,
    capability: 'task.hold',
    departmentScoped: true,
    requires: ['hold_reason'],
  },
  resume: {
    from: [S.ON_HOLD],
    to: S.IN_PROGRESS,
    capability: 'task.hold',
    departmentScoped: true,
    requires: ['artist_selected'],
  },
  resume_unassigned: {
    from: [S.ON_HOLD],
    to: S.UNASSIGNED,
    capability: 'task.hold',
    departmentScoped: true,
  },
  cancel: {
    from: [
      S.UNASSIGNED, S.OFFERED, S.IN_PROGRESS, S.INTERNAL_REVIEW,
      S.AWAITING_CLIENT, S.REVISION_NEEDED, S.ON_HOLD, S.CLIENT_APPROVED,
    ],
    to: S.CANCELLED,
    capability: 'task.cancel',
    requires: ['cancel_reason'],
    flags: ['compensation_review'],
  },
});

const TERMINAL_STATES = Object.freeze([S.CANCELLED]);

class TransitionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

function getTransition(action) {
  const transition = TRANSITIONS[action];
  if (!transition) throw new TransitionError(`Unknown task action: ${action}`, 'unknown_action');
  return transition;
}

function canTransition(action, fromState) {
  const transition = TRANSITIONS[action];
  if (!transition) return false;
  return transition.from.includes(fromState);
}

/**
 * Throws unless the task is in a state this action accepts. Callers run this
 * inside the same transaction as the write, which is what makes a double
 * button click harmless: the second attempt no longer matches `from`.
 */
function assertTransition(action, fromState) {
  const transition = getTransition(action);
  if (!transition.from.includes(fromState)) {
    throw new TransitionError(
      `Cannot ${action.replace(/_/g, ' ')} a task that is ${STATE_LABELS[fromState] || fromState}.`,
      'illegal_transition'
    );
  }
  return transition;
}

function nextState(action) {
  return getTransition(action).to;
}

function availableActions(fromState) {
  return Object.entries(TRANSITIONS)
    .filter(([, transition]) => transition.from.includes(fromState))
    .map(([action]) => action);
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

function stateLabel(state) {
  return STATE_LABELS[state] || state;
}

module.exports = {
  TASK_STATES,
  STATE_LABELS,
  TRANSITIONS,
  TERMINAL_STATES,
  TransitionError,
  getTransition,
  canTransition,
  assertTransition,
  nextState,
  availableActions,
  isTerminal,
  stateLabel,
};
