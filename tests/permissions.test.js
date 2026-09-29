const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CAPABILITIES: C,
  PermissionError,
  resolveActor,
  can,
  assertCan,
  isOwner,
  isAssignedArtist,
  canViewTaskFinance,
  canClaimStudio,
} = require('../src/domain/permissions');

const MODELLING = { id: 1, key: 'modelling', leader_role_id: 'role-lead-model', member_role_id: 'role-model' };
const VFX = { id: 2, key: 'vfx', leader_role_id: 'role-lead-vfx', member_role_id: 'role-vfx' };
const DEPARTMENTS = [MODELLING, VFX];

const CONFIG = { owner_user_id: 'owner-1', owner_role_id: 'role-owner' };

function actorFor({ userId, roleIds = [], roleCapabilities = [], guildOwnerId = null }) {
  return resolveActor({ userId, roleIds, config: CONFIG, departments: DEPARTMENTS, roleCapabilities, guildOwnerId });
}

test('the owner is recognised by user id, owner role, or guild ownership', () => {
  assert.equal(isOwner({ userId: 'owner-1', config: CONFIG }), true);
  assert.equal(isOwner({ userId: 'x', roleIds: ['role-owner'], config: CONFIG }), true);
  assert.equal(isOwner({ userId: 'x', config: CONFIG, guildOwnerId: 'x' }), true);
  assert.equal(isOwner({ userId: 'x', config: CONFIG }), false);
});

test('the owner holds every capability in every department', () => {
  const owner = actorFor({ userId: 'owner-1' });
  for (const capability of Object.values(C)) {
    assert.equal(can(owner, capability), true, `owner should hold ${capability}`);
    assert.equal(can(owner, capability, { departmentId: VFX.id }), true);
  }
});

test('a group leader runs their own department only', () => {
  const leader = actorFor({ userId: 'lead-model', roleIds: ['role-lead-model'] });

  assert.deepEqual(leader.leadDepartmentIds, [MODELLING.id]);
  assert.equal(can(leader, C.TASK_OFFER, { departmentId: MODELLING.id }), true);
  assert.equal(can(leader, C.REVIEW_INTERNAL, { departmentId: MODELLING.id }), true);
  assert.equal(can(leader, C.TASK_REASSIGN, { departmentId: MODELLING.id }), true);

  assert.equal(can(leader, C.TASK_OFFER, { departmentId: VFX.id }), false);
  assert.equal(can(leader, C.REVIEW_INTERNAL, { departmentId: VFX.id }), false);
  // A department-scoped capability with no department in context is refused.
  assert.equal(can(leader, C.TASK_OFFER), false);
});

test('a group leader can propose pay but never approve it', () => {
  const leader = actorFor({ userId: 'lead-model', roleIds: ['role-lead-model'] });
  assert.equal(can(leader, C.TASK_PAY_PROPOSE, { departmentId: MODELLING.id }), true);
  assert.equal(can(leader, C.TASK_PAY_APPROVE, { departmentId: MODELLING.id }), false);
  assert.equal(can(leader, C.TASK_PAY_APPROVE), false);
});

test('finance and client decisions are owner-only by default', () => {
  const leader = actorFor({ userId: 'lead-model', roleIds: ['role-lead-model'] });
  for (const capability of [
    C.CLIENT_RECORD,
    C.PAYMENT_RECORD,
    C.CLIENT_RECEIPT_RECORD,
    C.FINANCE_VIEW_ALL,
    C.CONFIG_MANAGE,
    C.TASK_CANCEL,
  ]) {
    assert.equal(can(leader, capability), false, `${capability} must not be default for leaders`);
  }
});

test('an ordinary artist holds no capabilities', () => {
  const artist = actorFor({ userId: 'artist-1', roleIds: ['role-model'] });
  assert.equal(artist.isOwner, false);
  assert.equal(artist.capabilities.size, 0);
  assert.equal(can(artist, C.TASK_OFFER, { departmentId: MODELLING.id }), false);
  assert.equal(can(artist, C.REVIEW_INTERNAL, { departmentId: MODELLING.id }), false);
});

test('capabilities can be granted to any role without touching code', () => {
  const finance = actorFor({
    userId: 'accountant',
    roleIds: ['role-finance'],
    roleCapabilities: [{ role_id: 'role-finance', capability: C.FINANCE_VIEW_ALL }],
  });

  assert.equal(can(finance, C.FINANCE_VIEW_ALL), true);
  assert.equal(can(finance, C.PAYMENT_RECORD), false, 'only what was granted');
});

test('a granted department-scoped capability still needs leadership of that department', () => {
  const granted = actorFor({
    userId: 'helper',
    roleIds: ['role-helper'],
    roleCapabilities: [{ role_id: 'role-helper', capability: C.REVIEW_INTERNAL }],
  });

  assert.equal(granted.capabilities.has(C.REVIEW_INTERNAL), true);
  assert.equal(can(granted, C.REVIEW_INTERNAL, { departmentId: MODELLING.id }), false);
});

test('assertCan explains a department-scope failure differently from a missing capability', () => {
  const leader = actorFor({ userId: 'lead-model', roleIds: ['role-lead-model'] });

  assert.throws(
    () => assertCan(leader, C.TASK_OFFER, { departmentId: VFX.id }),
    (error) => error instanceof PermissionError && /department you lead/.test(error.message)
  );
  assert.throws(
    () => assertCan(leader, C.PAYMENT_RECORD),
    (error) => error instanceof PermissionError && !/department you lead/.test(error.message)
  );
  assert.doesNotThrow(() => assertCan(leader, C.TASK_OFFER, { departmentId: MODELLING.id }));
});

test('artists act on their own work without a capability, and only their own', () => {
  const artist = actorFor({ userId: 'artist-1' });
  assert.equal(isAssignedArtist(artist, { artist_user_id: 'artist-1' }), true);
  assert.equal(isAssignedArtist(artist, { artist_user_id: 'artist-2' }), false);
  assert.equal(isAssignedArtist(artist, { artist_user_id: null }), false);
});

test('pay visibility: own task yes, other artists no, owner and finance all', () => {
  const artist = actorFor({ userId: 'artist-1' });
  const owner = actorFor({ userId: 'owner-1' });
  const leader = actorFor({ userId: 'lead-model', roleIds: ['role-lead-model'] });
  const finance = actorFor({
    userId: 'accountant',
    roleIds: ['role-finance'],
    roleCapabilities: [{ role_id: 'role-finance', capability: C.FINANCE_VIEW_ALL }],
  });

  const ownTask = { artist_user_id: 'artist-1', department_id: MODELLING.id };
  const otherTask = { artist_user_id: 'artist-2', department_id: MODELLING.id };

  assert.equal(canViewTaskFinance(artist, ownTask), true);
  assert.equal(canViewTaskFinance(artist, otherTask), false);
  assert.equal(canViewTaskFinance(owner, otherTask), true);
  assert.equal(canViewTaskFinance(finance, otherTask), true);
  assert.equal(canViewTaskFinance(leader, otherTask), false, 'leaders do not get a finance view by default');
});

test('a null actor is never permitted anything', () => {
  assert.equal(can(null, C.TASK_OFFER), false);
  assert.equal(canViewTaskFinance(null, { artist_user_id: 'x' }), false);
  assert.throws(() => assertCan(null, C.TASK_OFFER), PermissionError);
});

// ---------------------------------------------------------------------------
// Claiming the studio on first run
// ---------------------------------------------------------------------------

test('the Discord server owner can always claim the studio', () => {
  assert.equal(canClaimStudio({ userId: 'u1', guildOwnerId: 'u1', config: {} }), true);
  assert.equal(canClaimStudio({ userId: 'u1', guildOwnerId: 'u1', config: { owner_user_id: 'someone-else' } }), true);
});

test('somebody who manages the server can claim it while it is unclaimed', () => {
  // The case that locked a real studio out: a founder who did not create the
  // Discord server, on a bot nobody has set up yet.
  assert.equal(canClaimStudio({ userId: 'founder', guildOwnerId: 'somebody-else', managesServer: true, config: {} }), true);
});

test('managing the server is not enough once the studio has an owner', () => {
  assert.equal(
    canClaimStudio({ userId: 'founder', guildOwnerId: 'somebody-else', managesServer: true, config: { owner_user_id: 'owner-1' } }),
    false,
    'the first-run door shuts once somebody has claimed it'
  );
});

test('the recorded owner can re-run setup', () => {
  assert.equal(canClaimStudio({ userId: 'owner-1', guildOwnerId: 'somebody-else', config: { owner_user_id: 'owner-1' } }), true);
});

test('an ordinary member cannot claim the studio', () => {
  assert.equal(canClaimStudio({ userId: 'artist-1', guildOwnerId: 'somebody-else', managesServer: false, config: {} }), false);
  assert.equal(
    canClaimStudio({ userId: 'artist-1', guildOwnerId: 'somebody-else', managesServer: false, config: { owner_user_id: 'owner-1' } }),
    false
  );
});

test('an owner role claims it even without Discord server permissions', () => {
  assert.equal(
    canClaimStudio({ userId: 'u1', guildOwnerId: 'somebody-else', roleIds: ['role-owner'], config: { owner_role_id: 'role-owner' } }),
    true
  );
});
