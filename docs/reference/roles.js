const { CAPABILITIES } = require('../../src/domain/permissions');

/**
 * The tokens in gates.js, in plain language.
 *
 * `who` is what somebody reads in the table. `why` explains the rule when the
 * rule is the interesting part — a permission nobody understands gets granted
 * to everybody within a month.
 *
 * `tier` groups the command list by who it is really for, and drives the colour
 * of the badge. It is a presentation choice only; the gate is what the code
 * enforces.
 */
const TIERS = Object.freeze({
  ANYONE: 'anyone',
  ARTIST: 'artist',
  LEADER: 'leader',
  MANAGER: 'manager',
  OWNER: 'owner',
});

const TIER_LABELS = Object.freeze({
  anyone: 'Anyone on the team',
  artist: 'The person doing the work',
  leader: 'Group leader',
  manager: 'Manager',
  owner: 'Owner',
});

const ROLES = Object.freeze({
  // --- no gate at all -----------------------------------------------------
  ANYONE: { tier: TIERS.ANYONE, who: 'Anyone' },
  ANYONE_OWN: {
    tier: TIERS.ANYONE,
    who: 'Anyone — their own only',
    why: 'Shows you your own figures. Nobody sees anybody else’s pay through it.',
  },
  ANYONE_SCOPED: {
    tier: TIERS.ANYONE,
    who: 'Anyone — results filtered',
    why: 'Returns only what you already have access to, so a result cannot reveal that something exists.',
  },
  STAFF: { tier: TIERS.ANYONE, who: 'Anyone on the team' },
  STAFF_MONEY_HIDDEN: {
    tier: TIERS.ANYONE,
    who: 'Anyone — money hidden',
    why: 'Prices and pay appear only if you could see them anyway (finance.view_all or owner).',
  },

  // --- the artist on the task --------------------------------------------
  ASSIGNED_ARTIST: {
    tier: TIERS.ARTIST,
    who: 'The assigned artist',
    why: 'Your own action on your own task. Nobody reports progress or submits on somebody else’s behalf.',
  },
  OWN_OR_LEADER: {
    tier: TIERS.ARTIST,
    who: 'The artist, or their leader',
    why: 'Your own work, or work in a department you lead.',
  },
  TRIAL_OWNER: {
    tier: TIERS.ARTIST,
    who: 'Whoever the trial belongs to',
    why: 'A trial brief is submitted by the person on trial and nobody else.',
  },

  // --- group leaders, inside their own department -------------------------
  LEADER_OWN_DEPT: {
    tier: TIERS.LEADER,
    who: 'Group leader (own department)',
    why: 'The owner sees every department; a leader sees the ones they lead.',
  },
  TASK_OFFER_DEPT: { tier: TIERS.LEADER, who: 'Group leader (own department)', capability: CAPABILITIES.TASK_OFFER },
  TASK_EDIT_DEPT: { tier: TIERS.LEADER, who: 'Group leader (own department)', capability: CAPABILITIES.TASK_EDIT },
  TASK_HOLD_DEPT: { tier: TIERS.LEADER, who: 'Group leader (own department)', capability: CAPABILITIES.TASK_HOLD },
  TASK_REASSIGN_DEPT: { tier: TIERS.LEADER, who: 'Group leader (own department)', capability: CAPABILITIES.TASK_REASSIGN },
  REVIEW_INTERNAL_DEPT: { tier: TIERS.LEADER, who: 'Group leader (own department)', capability: CAPABILITIES.REVIEW_INTERNAL },
  TASK_CREATE: { tier: TIERS.LEADER, who: 'Leader or manager', capability: CAPABILITIES.TASK_CREATE },
  SUMMARY_VIEW: { tier: TIERS.LEADER, who: 'Leader, manager or owner', capability: CAPABILITIES.SUMMARY_VIEW },
  LEADER_OR_SUMMARY: {
    tier: TIERS.LEADER,
    who: 'Leader or owner',
    why: 'A leader sees the departments they lead; the owner sees the studio.',
  },
  LEADER_OR_MANAGER: {
    tier: TIERS.LEADER,
    who: 'Leader or manager',
    why: 'Putting somebody forward is a leader’s job; deciding is the owner’s.',
  },
  PAY_SET_OR_PROPOSE: {
    tier: TIERS.LEADER,
    who: 'Leader proposes, owner sets',
    why: 'A leader can put a figure forward. Only the owner makes it the agreed pay.',
  },
  TASK_VIEW: {
    tier: TIERS.LEADER,
    who: 'Your task, your department, or owner',
    why: 'You see tasks assigned to you, tasks in a department you lead, or everything if you hold finance access.',
  },
  TASK_FINANCE_SCOPED: {
    tier: TIERS.LEADER,
    who: 'Leader or owner sees all; others their own',
    why: 'Everybody’s figures on a shared task are a leader-and-above view.',
  },
  BLOCKER_CLEAR: {
    tier: TIERS.LEADER,
    who: 'Whoever raised it, their leader, or the owner',
    why: 'The person who hit the blocker usually knows first that it is gone.',
  },
  HOLDER_OR_LEADER: {
    tier: TIERS.LEADER,
    who: 'The artist, or their leader',
    why: 'An artist can ask for more time on their own work; a leader can change the date.',
  },
  MANAGER_OR_OWN_DEPT: {
    tier: TIERS.LEADER,
    who: 'Manager, or the department it is against',
    why: 'You handle problems reported against work your department did.',
  },
  ISSUE_DECIDE: {
    tier: TIERS.LEADER,
    who: 'Leader decides revisions, owner decides money',
    why: 'A free fix is a leader’s call. Anything that costs money is the owner’s.',
  },
  PROJECT_EDIT_OR_REVIEWER: {
    tier: TIERS.LEADER,
    who: 'Manager, reviewer or owner',
  },
  CLIENT_FACING_VIEW: {
    tier: TIERS.LEADER,
    who: 'Leader, manager or owner',
  },

  // --- managers -----------------------------------------------------------
  PROJECT_CREATE: { tier: TIERS.MANAGER, who: 'Manager or owner', capability: CAPABILITIES.PROJECT_CREATE },
  PROJECT_EDIT: { tier: TIERS.MANAGER, who: 'Manager or owner', capability: CAPABILITIES.PROJECT_EDIT },
  PROJECT_EDIT_RELEASE: {
    tier: TIERS.MANAGER,
    who: 'Manager or owner',
    why: 'Releasing against unmet conditions additionally needs client.record, so an override is always a deliberate act.',
  },

  // --- owner --------------------------------------------------------------
  CONFIG_MANAGE: { tier: TIERS.OWNER, who: 'Owner', capability: CAPABILITIES.CONFIG_MANAGE },
  STAFF_MANAGE: { tier: TIERS.OWNER, who: 'Owner', capability: CAPABILITIES.STAFF_MANAGE },
  TASK_PAY_APPROVE: { tier: TIERS.OWNER, who: 'Owner', capability: CAPABILITIES.TASK_PAY_APPROVE },
  TASK_CANCEL: { tier: TIERS.OWNER, who: 'Owner', capability: CAPABILITIES.TASK_CANCEL },
  PAYMENT_RECORD: { tier: TIERS.OWNER, who: 'Owner', capability: CAPABILITIES.PAYMENT_RECORD },
  CLIENT_RECEIPT_RECORD: { tier: TIERS.OWNER, who: 'Owner', capability: CAPABILITIES.CLIENT_RECEIPT_RECORD },
  CLIENT_RECORD: { tier: TIERS.OWNER, who: 'Owner or client manager', capability: CAPABILITIES.CLIENT_RECORD },
  CLIENT_RECORD_DEPT: {
    tier: TIERS.OWNER,
    who: 'Owner or client manager',
    why: 'Recording what a client decided is a statement about the client, so it is not a leader’s call by default.',
  },
  FINANCE_VIEW_ALL: { tier: TIERS.OWNER, who: 'Owner', capability: CAPABILITIES.FINANCE_VIEW_ALL },
  FIRST_RUN: {
    tier: TIERS.OWNER,
    who: 'Owner, or whoever sets it up first',
    why: 'Before an owner is recorded, anybody who can manage the server may claim the studio once. After that it needs config.manage.',
  },
});

/** A gate token, or several joined with `+`, turned into one description. */
function describe(token) {
  const parts = String(token).split('+');
  const roles = parts.map((part) => ROLES[part]).filter(Boolean);

  if (roles.length !== parts.length) {
    // Loud rather than a blank cell: an unmapped token is a documentation bug.
    return { who: `UNMAPPED: ${token}`, tier: TIERS.OWNER, capabilities: [], why: null };
  }

  const capabilities = [...new Set(roles.map((role) => role.capability).filter(Boolean))];
  const order = [TIERS.ANYONE, TIERS.ARTIST, TIERS.LEADER, TIERS.MANAGER, TIERS.OWNER];

  // Needing several capabilities means needing all of them, so the narrowest
  // description is the true one — not the two joined together, which produced
  // nonsense like "Owner + Owner". Highest tier wins; on a tie the one that is
  // not a choice of two ("Owner or client manager") wins, because "and" beats
  // "or" when both are required.
  const narrowest = [...roles].sort((a, b) => {
    const byTier = order.indexOf(b.tier) - order.indexOf(a.tier);
    if (byTier !== 0) return byTier;
    return Number(a.who.includes(' or ')) - Number(b.who.includes(' or '));
  })[0];

  return {
    who: narrowest.who,
    tier: narrowest.tier,
    capabilities,
    why: [...new Set(roles.map((role) => role.why).filter(Boolean))].join(' ') || null,
  };
}

module.exports = { TIERS, TIER_LABELS, ROLES, describe };
