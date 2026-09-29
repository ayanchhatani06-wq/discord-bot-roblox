const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_STATES: S,
  TRANSITIONS,
  TransitionError,
  canTransition,
  assertTransition,
  nextState,
  availableActions,
  isTerminal,
  stateLabel,
} = require('../src/domain/taskState');

test('the happy path runs unassigned -> client approved', () => {
  const path = [
    ['offer', S.UNASSIGNED, S.OFFERED],
    ['offer_accept', S.OFFERED, S.IN_PROGRESS],
    ['submit_final', S.IN_PROGRESS, S.INTERNAL_REVIEW],
    ['review_ready_for_client', S.INTERNAL_REVIEW, S.AWAITING_CLIENT],
    ['client_approve', S.AWAITING_CLIENT, S.CLIENT_APPROVED],
  ];

  for (const [action, from, to] of path) {
    assert.equal(canTransition(action, from), true, `${action} should be legal from ${from}`);
    assert.equal(nextState(action), to);
  }
});

test('a declined offer returns the task to the leader queue', () => {
  assert.equal(nextState('offer_decline'), S.UNASSIGNED);
  assert.equal(nextState('offer_expire'), S.UNASSIGNED);
  assert.equal(nextState('offer_withdraw'), S.UNASSIGNED);
  assert.ok(TRANSITIONS.offer_decline.requires.includes('decline_reason'));
});

test('revisions loop back to the artist and can be resubmitted', () => {
  assert.equal(nextState('review_request_changes'), S.REVISION_NEEDED);
  assert.equal(nextState('client_request_revisions'), S.REVISION_NEEDED);
  assert.equal(canTransition('submit_final', S.REVISION_NEEDED), true);
});

test('internal review is not client approval', () => {
  assert.equal(nextState('review_ready_for_client'), S.AWAITING_CLIENT);
  assert.notEqual(nextState('review_ready_for_client'), S.CLIENT_APPROVED);
  // Only the client.record capability can reach the approved state.
  const toApproved = Object.values(TRANSITIONS).filter((t) => t.to === S.CLIENT_APPROVED);
  assert.equal(toApproved.length, 1);
  assert.equal(toApproved[0].capability, 'client.record');
});

test('illegal transitions are refused', () => {
  const illegal = [
    ['client_approve', S.IN_PROGRESS],
    ['client_approve', S.INTERNAL_REVIEW],
    ['offer_accept', S.UNASSIGNED],
    ['submit_final', S.AWAITING_CLIENT],
    ['review_ready_for_client', S.IN_PROGRESS],
    ['offer', S.IN_PROGRESS],
  ];

  for (const [action, from] of illegal) {
    assert.equal(canTransition(action, from), false, `${action} must be illegal from ${from}`);
    assert.throws(() => assertTransition(action, from), TransitionError);
  }
});

test('a second click cannot repeat a transition', () => {
  // First accept moves offered -> in_progress; the same click arriving twice
  // no longer matches a legal "from" state.
  assert.doesNotThrow(() => assertTransition('offer_accept', S.OFFERED));
  assert.throws(() => assertTransition('offer_accept', S.IN_PROGRESS), TransitionError);

  assert.doesNotThrow(() => assertTransition('client_approve', S.AWAITING_CLIENT));
  assert.throws(() => assertTransition('client_approve', S.CLIENT_APPROVED), TransitionError);
});

test('cancelled work is terminal and preserved', () => {
  assert.equal(isTerminal(S.CANCELLED), true);
  assert.equal(availableActions(S.CANCELLED).length, 0);
  assert.equal(canTransition('cancel', S.CANCELLED), false);
  for (const state of [S.UNASSIGNED, S.IN_PROGRESS, S.AWAITING_CLIENT, S.CLIENT_APPROVED, S.ON_HOLD]) {
    assert.equal(canTransition('cancel', state), true);
  }
});

test('reopening approved work is possible but flagged for scope review', () => {
  assert.equal(canTransition('client_reopen', S.CLIENT_APPROVED), true);
  assert.deepEqual(TRANSITIONS.client_reopen.flags, ['scope_review']);
});

test('reassignment demands a reason and flags compensation', () => {
  const reassign = TRANSITIONS.reassign;
  assert.ok(reassign.requires.includes('reassign_reason'));
  assert.deepEqual(reassign.flags, ['compensation_review']);
  assert.equal(reassign.to, S.OFFERED, 'the new artist still has to accept');
  assert.equal(canTransition('reassign', S.IN_PROGRESS), true);
  assert.equal(canTransition('reassign', S.UNASSIGNED), false);
});

test('offering requires approved pay and a chosen artist', () => {
  assert.deepEqual(TRANSITIONS.offer.requires, ['pay_approved', 'artist_selected']);
  assert.equal(TRANSITIONS.offer.departmentScoped, true);
});

test('artist-driven actions are gated on the task, not on a capability', () => {
  for (const action of ['offer_accept', 'offer_decline', 'submit_final']) {
    assert.equal(TRANSITIONS[action].capability, undefined);
    assert.ok(['offered_artist', 'assigned_artist'].includes(TRANSITIONS[action].actor));
  }
});

test('unknown actions fail loudly', () => {
  assert.equal(canTransition('teleport', S.UNASSIGNED), false);
  assert.throws(() => assertTransition('teleport', S.UNASSIGNED), TransitionError);
});

test('every state has a human label', () => {
  for (const state of Object.values(S)) {
    assert.equal(typeof stateLabel(state), 'string');
    assert.notEqual(stateLabel(state), state.replace(/_/g, ' '));
  }
});
