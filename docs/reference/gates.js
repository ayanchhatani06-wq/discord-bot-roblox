/**
 * Who may run each command, read out of the command source rather than
 * remembered. `npm run reference` turns this plus the command builders into
 * docs/COMMANDS.pdf.
 *
 * `default` covers every subcommand of that command; `subs` overrides one.
 * Values are either a capability key from src/domain/permissions.js, several
 * joined with `+` when a subcommand needs all of them, or one of the plain
 * tokens described in ROLES below.
 *
 * Keeping this beside the generator rather than inside it means the day a gate
 * changes in a command, the correction lands in one obvious place — and the
 * cross-check in the generator fails loudly if a command or subcommand is
 * added without a line here.
 */
module.exports = {
  files: { default: 'PROJECT_EDIT', subs: {
    search: 'STAFF', portfolio: 'STAFF', 'roblox-ids': 'STAFF',
  } },
  bonuses: { default: 'TASK_PAY_APPROVE', subs: { mine: 'ANYONE', rules: 'SUMMARY_VIEW' } },
  clients: { default: 'PROJECT_EDIT' },
  send: { default: 'PROJECT_EDIT', subs: {
    conditions: 'CONFIG_MANAGE', check: 'PROJECT_EDIT_OR_REVIEWER', release: 'PROJECT_EDIT_RELEASE',
  } },
  'money-in': { default: 'CLIENT_RECEIPT_RECORD', subs: { list: 'FINANCE_VIEW_ALL' } },
  desk: { default: 'ANYONE', subs: { group: 'LEADER_OWN_DEPT', owner: 'SUMMARY_VIEW' } },
  quotes: { default: 'PROJECT_CREATE', subs: {
    template: 'TASK_PAY_APPROVE', 'approve-quote': 'TASK_PAY_APPROVE',
  } },
  concern: { default: 'CONFIG_MANAGE', subs: { raise: 'ANYONE', mine: 'ANYONE' } },
  pay: { default: 'PAYMENT_RECORD', subs: {
    budget: 'FINANCE_VIEW_ALL',
    'budget-override': 'FINANCE_VIEW_ALL+PAYMENT_RECORD',
    'budget-restore': 'FINANCE_VIEW_ALL+PAYMENT_RECORD',
    'client-receipt': 'CLIENT_RECEIPT_RECORD',
    ledger: 'FINANCE_VIEW_ALL', outstanding: 'FINANCE_VIEW_ALL',
    balance: 'FINANCE_VIEW_ALL', splits: 'FINANCE_VIEW_ALL', sent: 'FINANCE_VIEW_ALL',
    'approve-all': 'TASK_PAY_APPROVE',
  } },
  find: { default: 'ANYONE_SCOPED' },
  'who-is-free': { default: 'LEADER_OR_SUMMARY' },
  go: { default: 'ANYONE' },
  help: { default: 'ANYONE' },
  problems: { default: 'MANAGER_OR_OWN_DEPT', subs: { decide: 'ISSUE_DECIDE' } },
  change: { default: 'TASK_EDIT_DEPT', subs: {
    flags: 'SUMMARY_VIEW', reassign: 'TASK_REASSIGN_DEPT',
    hold: 'TASK_HOLD_DEPT', resume: 'TASK_HOLD_DEPT',
    cancel: 'TASK_CANCEL', compensate: 'PAYMENT_RECORD',
  } },
  messages: { default: 'CLIENT_RECORD', subs: {
    placeholders: 'ANYONE', 'template-approve': 'CLIENT_RECORD+CONFIG_MANAGE',
  } },
  team: { default: 'STAFF_MANAGE', subs: {
    'trial mine': 'ANYONE',
    'trial submit': 'TRIAL_OWNER',
    'recommend new': 'LEADER_OR_MANAGER',
  } },
  deadlines: { default: 'TASK_EDIT_DEPT', subs: {
    templates: 'ANYONE', template: 'TASK_CREATE', batch: 'TASK_CREATE',
    risks: 'ANYONE_SCOPED', blockers: 'ANYONE_SCOPED', extensions: 'ANYONE_SCOPED',
    ready: 'ANYONE', chain: 'ANYONE',
    'clear-blocker': 'BLOCKER_CLEAR', extend: 'HOLDER_OR_LEADER',
    'decide-extension': 'TASK_EDIT_DEPT',
  } },
  'staff-rules': { default: 'CONFIG_MANAGE', subs: {
    list: 'ANYONE', read: 'ANYONE', who: 'STAFF_MANAGE',
  } },
  profile: { default: 'ANYONE', subs: { assign: 'STAFF_MANAGE' } },
  orders: { default: 'PROJECT_EDIT', subs: {
    create: 'PROJECT_CREATE', bulk: 'TASK_CREATE',
    view: 'STAFF_MONEY_HIDDEN', list: 'STAFF', tasks: 'STAFF_MONEY_HIDDEN',
  } },
  proof: { default: 'CLIENT_RECORD', subs: { record: 'CLIENT_RECORD+FINANCE_VIEW_ALL' } },
  reorder: { default: 'PROJECT_CREATE' },
  reports: { default: 'SUMMARY_VIEW', subs: {
    payouts: 'SUMMARY_VIEW+FINANCE_VIEW_ALL',
    schedule: 'SUMMARY_VIEW+CONFIG_MANAGE',
    'run-reminders': 'SUMMARY_VIEW+CONFIG_MANAGE',
  } },
  review: { default: 'REVIEW_INTERNAL_DEPT', subs: {
    'awaiting-client': 'CLIENT_FACING_VIEW', client: 'CLIENT_RECORD_DEPT',
  } },
  setup: { default: 'CONFIG_MANAGE', subs: {
    doctor: 'SUMMARY_VIEW',
    setup: 'FIRST_RUN',
    'backup now': 'CONFIG_MANAGE+FINANCE_VIEW_ALL',
    'backup export': 'CONFIG_MANAGE+FINANCE_VIEW_ALL',
    'backup verify': 'CONFIG_MANAGE+FINANCE_VIEW_ALL',
    'backup restore': 'CONFIG_MANAGE+FINANCE_VIEW_ALL',
  } },
  task: { default: 'TASK_OFFER_DEPT', subs: {
    create: 'TASK_CREATE', mine: 'ANYONE', view: 'TASK_VIEW',
    pay: 'PAY_SET_OR_PROPOSE', 'approve-pay': 'TASK_PAY_APPROVE',
    edit: 'TASK_EDIT_DEPT',
    'helpers add': 'TASK_EDIT_DEPT',
    'helpers remove': 'TASK_EDIT_DEPT',
    'helpers pay': 'PAY_SET_OR_PROPOSE',
    'helpers list': 'TASK_FINANCE_SCOPED',
  } },
  time: { default: 'ANYONE' },
  'my-work': { default: 'ASSIGNED_ARTIST', subs: {
    earnings: 'ANYONE_OWN', history: 'OWN_OR_LEADER',
  } },
};
