/**
 * What each command is *for*, and where the bot's output actually lands.
 *
 * The first reference was 36 commands in alphabetical order, which is a lookup
 * table: fine if you already know the name, useless if you are trying to find
 * the thing that does what you want. These groups are the fix — you look under
 * what you are trying to do.
 */

/** Ordered. A section only appears on a sheet if that reader has something in it. */
const GROUPS = [
  { key: 'start', title: 'Finding your way around' },
  { key: 'work', title: 'Work and deadlines' },
  { key: 'money', title: 'Money' },
  { key: 'people', title: 'People and time' },
  { key: 'clients', title: 'Clients and orders' },
  { key: 'files', title: 'Files and proof' },
  { key: 'watch', title: 'Keeping an eye on things' },
  { key: 'setup', title: 'Setting the studio up' },
];

/** Every command, in exactly one group. The build fails if one is missing. */
const COMMAND_GROUPS = {
  go: 'start', help: 'start', find: 'start', desk: 'start',

  task: 'work', 'my-work': 'work', deadlines: 'work', change: 'work', review: 'work', 'who-is-free': 'work',

  pay: 'money', 'money-in': 'money', bonuses: 'money', contrib: 'money',

  profile: 'people', time: 'people', people: 'people',
  recommend: 'people', trial: 'people', 'staff-rules': 'people',

  orders: 'clients', clients: 'clients', quotes: 'clients', reorder: 'clients',
  messages: 'clients', problems: 'clients', send: 'clients',

  files: 'files', proof: 'files',

  reports: 'watch', summary: 'watch', concern: 'watch',

  studio: 'setup', web: 'setup', automation: 'setup', backup: 'setup',
};

/**
 * Where the bot's output actually turns up.
 *
 * A command list tells you what to type and not one thing about where the answer
 * appears — which is the first question anybody actually has. Every line here is
 * read off the code: the channels are the four `/studio channel` purposes, the
 * boards are the messages staffBoard edits in place, and the DM fallback is what
 * notify.js does when somebody's DMs are shut.
 */
const PLACES = {
  staff: [
    {
      where: 'The staff info board channel',
      what: 'One message per department, listing who is in it, what each person has on, and their local time. ' +
        'The bot edits these in place and refreshes them on a timer — they are never re-posted, so the channel stays clean.',
      note: 'Read-only. Nobody types anything here.',
    },
    {
      where: 'Your DMs',
      what: 'Task offers with Accept and Decline buttons, pay decisions, deadline reminders, and anything that needs you personally.',
      note: 'If your DMs are closed the bot posts it to the private staff channel instead, so it is never silently lost. Open your DMs to this server.',
    },
    {
      where: '/desk me',
      what: 'Everything of yours in one place: offers waiting, what you hold, deadlines, and your pay. This is the one to run each morning.',
      note: 'Private to you — only you see the reply.',
    },
    {
      where: 'Nowhere public',
      what: 'Progress notes, submissions and reviews are not posted to a channel. /my-work progress replies to you privately ' +
        'and sends your leader a DM; your leader\u2019s decision comes back the same way.',
      note: 'So there is no "progress" channel to watch, and nothing you do lands in front of the whole server.',
    },
    {
      where: 'Your browser',
      what: '/desk web-link gives you a one-time link to the same desk in a browser, read-only.',
      note: 'The link expires. Ask for a new one whenever you need it.',
    },
  ],

  leader: [
    {
      where: '/desk group',
      what: 'Your department: the queue, who is loaded, what is waiting on your review, and which deadlines are at risk.',
      note: 'Private to you. Shows only the departments you lead.',
    },
    {
      where: 'The staff info board channel',
      what: 'Your department’s board, refreshed automatically. Same message, edited in place.',
    },
    {
      where: 'Your DMs',
      what: 'Work submitted for your review, artists accepting or declining offers, blockers raised, and extension requests.',
      note: 'Falls back to the private staff channel if your DMs are closed.',
    },
    {
      where: '/task queue',
      what: 'Unassigned work in your departments, each with a button to pick an artist. This is where new tasks show up for you.',
    },
    {
      where: 'Nowhere public',
      what: 'Your review decisions go to the artist as a DM, not to a channel. Nobody is corrected in front of the server.',
      note: 'The decision is still on the record — /my-work history shows every review on a task.',
    },
  ],

  owner: [
    {
      where: '/desk owner',
      what: 'Everything waiting on a decision from you: pay to approve, quotes to price, client decisions to record, money to release.',
      note: 'Private to you. Start here.',
    },
    {
      where: '/go',
      what: 'The short version of the same thing — what is waiting on you right now, with the command for each.',
    },
    {
      where: 'The staff info board channel',
      what: 'Every department’s board. Set it with /studio channel purpose:Staff info board, set how often it rebuilds with ' +
        '/studio reminders board_refresh_minutes:, and force a rebuild with /studio refresh.',
      note: 'The boards have no command of their own — they post and refresh themselves once the channel is set.',
    },
    {
      where: 'The weekly summary channel',
      what: 'The management digest, posted on the schedule you set with /summary schedule. /summary now shows it without posting.',
    },
    {
      where: 'The audit log channel',
      what: 'A running record of what was changed and by whom.',
      note: 'Everything is written to the database regardless; this channel is just the readable copy.',
    },
    {
      where: 'The private staff channel',
      what: 'Where a DM goes when somebody’s DMs are closed, so a notification is never lost without you knowing.',
    },
    {
      where: 'Each client’s own channel',
      what: 'Their dashboard, posted and refreshed by /clients dashboard. It shows only what you have released to them.',
      note: 'Check it with /clients preview, which shows you exactly what they can see.',
    },
    {
      where: 'The website',
      what: 'The public pages, and the client area where a client who is not in Discord can sign in. /web status says what is currently live.',
    },
    {
      where: 'Inside the bot',
      what: 'Screenshots filed with /proof add are kept as files on the server, not as Discord links. Get one back with /proof show.',
      note: 'They travel with your backups. /backup now copies them next to the database.',
    },
  ],
};

/**
 * A server layout that matches how the bot posts.
 *
 * The bot never creates channels — it posts into ones you point it at. Four
 * channels do real work, and three of them should not be readable by everybody,
 * so they belong in one staff-only category rather than scattered.
 */
const SERVER_LAYOUT = {
  intro:
    'The bot does not create channels. You make them, then point the bot at each one with ' +
    '/studio channel. Everything below except the first is staff-only — put them in a category ' +
    'the client roles cannot see.',
  category: 'CYLOPS \u00b7 STAFF',
  channels: [
    {
      name: '#studio-board',
      purpose: 'Staff info board',
      what: 'One auto-refreshing message per department. Everyone on the team can read it; nobody types in it.',
      who: 'All staff can read. Nobody needs send access.',
    },
    {
      name: '#studio-alerts',
      purpose: 'DM fallback (private staff channel)',
      what: 'Where a notification lands when somebody\u2019s DMs are closed, so nothing is lost silently.',
      who: 'All staff. This is why it must not be client-visible.',
    },
    {
      name: '#studio-summary',
      purpose: 'Weekly management summary',
      what: 'The digest, on the schedule you set with /summary schedule.',
      who: 'You and your leaders.',
    },
    {
      name: '#studio-audit',
      purpose: 'Audit log',
      what: 'A readable record of what changed and who changed it.',
      who: 'You only. It names pay figures and client decisions.',
    },
  ],
  clients:
    'Clients get a channel each, outside this category, and you link it with /clients dashboard. ' +
    'A client sees only their own channel and only what you have released. Check with /clients preview.',
};

module.exports = { GROUPS, COMMAND_GROUPS, PLACES, SERVER_LAYOUT };
