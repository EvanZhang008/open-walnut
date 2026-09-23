/**
 * A canned mail provider, installed into the browser fixture's throwaway home the documented
 * author way: a directory in `plugins/` with a manifest that declares `dependencies: { mail }`
 * and attaches through `walnut.services.require('mail:base').registerProvider(spec)`. The base
 * never learns this plugin's name.
 *
 * It behaves like a mail server rather than like a stub, because three of the console's
 * behaviours are only honest against one:
 *
 * - THE READ FLAG IS SERVER STATE. `markRead` moves a `seen` set, and both `poll` and
 *   `listMailboxes` answer from it. A stub with static flags would re-ingest an unread envelope
 *   on the next poll and silently undo the console's optimistic badge.
 * - A WRONG CREDENTIAL IS A `ProviderError`, not a generic throw: `code: 'auth'` is what the
 *   plugin's route turns into a 401, which is what the dialog's "app password" sentence keys on.
 * - The HTML body is HOSTILE on purpose (script, an `onerror`, a remote pixel), and it is handed
 *   over RAW. Sanitizing here would test the fixture instead of the console.
 * - A SEND IS RECORDED, not swallowed. Every `provider.send` appends the exact `OutgoingMail` the
 *   base built to a json file in the fixture's throwaway home, so the write-path spec can assert
 *   what went over the wire (one send, both recipients, the html the server rendered, the
 *   `In-Reply-To` it copied from the cached message) instead of trusting the console's own words.
 *
 * With `PW_MAIL_INBOUND_PROVIDER=1` it ALSO registers a second provider that declares `send: false`, which is
 * the only way the console can see two accounts disagree: `MailAccountDto` carries no capabilities
 * and the contract's per-account override is on no route, so the console reads the provider's block.
 * It is a flag rather than the default because the read spec counts the provider options in the
 * add-an-account dialog.
 *
 * With `PW_MAIL_CTX=1` it registers BOTH of them with their setup forms removed, so the base adopts
 * one account of each at registration: one that can mark read and send, and one that can do neither.
 * That is the shape a row menu is graded against, since an item for something the provider cannot do
 * must not be drawn at all. See the block above `MAILBOXES` for the folders it adds.
 *
 * Addresses are `*.invalid` (RFC 2606) and nothing here resolves.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOUR = 60 * 60 * 1000;

/** Where a send is recorded. The fixture home is thrown away with the run. */
const OUTBOX = path.join(process.env.OPEN_WALNUT_HOME || os.tmpdir(), 'mail-fixture-sends.json');

/**
 * Append one send, atomically.
 *
 * Written to a temp file and RENAMED over the outbox, because the test polls this file while the
 * server writes it: a plain `writeFileSync` is observable half-written, and the reader's
 * `JSON.parse` would throw (or worse, the test would see one fewer send and call it a bug).
 */
function recordSend(entry) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(OUTBOX, 'utf8')); }
  catch { held = []; }
  held.push(entry);
  const staging = `${OUTBOX}.${process.pid}.tmp`;
  fs.writeFileSync(staging, JSON.stringify(held, null, 2));
  fs.renameSync(staging, OUTBOX);
  return held.length;
}
const now = Date.now();

/** Deep in the text, in the HTML half only: what the cached-search test looks for. */
const HTML_BODY = [
  '<div class="wrap">',
  '<h2>Quarterly keeper report</h2>',
  '<img src="https://example.invalid/pixel.png" width="1" height="1" onerror="alert(1)">',
  '<script>alert(1)</script>',
  '<p>Attendance held up through the wet months.</p>',
  '<p>The new <b>zebra</b> enclosure opens in May, and the boardwalk reopens with it.</p>',
  '<a href="javascript:alert(2)">Read the full report</a>',
  // The remote fetches that "Load images" would also release, and that no image count can see:
  // a video poster, an SVG image, and CSS urls in both an attribute and a style block.
  '<video poster="https://example.invalid/frame.jpg"></video>',
  '<svg><image href="https://example.invalid/svg.png"></image></svg>',
  '<p style="background-image: url(https://example.invalid/bg.png)">Sponsored</p>',
  '<style>.wrap { background: url("https://example.invalid/paper.png"); }</style>',
  '<p>Regards,<br>The keeper</p>',
  '</div>',
].join('');

const PLAIN_BODY = 'Lunch tomorrow at one?\n\nThe menu is at https://example.invalid/menu and I can book.\n\nAlice';

const ARCHIVE_BODY = 'Signed and filed. Nothing needed from you.';

const MESSAGES = [
  {
    messageId: 'INBOX:1:31',
    rfcMessageId: '<keeper-31@example.invalid>',
    mailboxId: 'INBOX',
    from: { name: 'Keeper Reports', address: 'keeper@example.invalid' },
    to: [{ name: 'Me', address: 'me@example.invalid' }],
    subject: 'Quarterly keeper report',
    snippet: 'Attendance held up through the wet months.',
    sentAt: now - 2 * HOUR,
    sentAtHeader: new Date(now - 2 * HOUR).toUTCString(),
    attachments: [{ id: '2', filename: 'attendance.pdf', mimeType: 'application/pdf', bytes: 18234 }],
    body: { format: 'html', html: HTML_BODY },
    unreadAtFirstSight: true,
  },
  {
    messageId: 'INBOX:1:30',
    rfcMessageId: '<alice-30@example.invalid>',
    mailboxId: 'INBOX',
    from: { name: 'Alice', address: 'alice@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: 'Lunch tomorrow',
    snippet: 'Lunch tomorrow at one?',
    sentAt: now - 5 * HOUR,
    attachments: [],
    body: { format: 'text', text: PLAIN_BODY },
    unreadAtFirstSight: true,
  },
  {
    messageId: 'INBOX:1:29',
    rfcMessageId: '<carol-29@example.invalid>',
    mailboxId: 'INBOX',
    from: { name: 'Carol', address: 'carol@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: 'Signed lease',
    snippet: 'Signed and filed.',
    sentAt: now - 26 * HOUR,
    attachments: [],
    body: { format: 'text', text: ARCHIVE_BODY },
    unreadAtFirstSight: false,
  },
  {
    messageId: 'Archive:1:4',
    rfcMessageId: '<dave-4@example.invalid>',
    mailboxId: 'Archive',
    from: { name: 'Dave', address: 'dave@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: 'Old thread about the boardwalk',
    snippet: 'Filed for later.',
    sentAt: now - 40 * 24 * HOUR,
    attachments: [],
    body: { format: 'text', text: 'Filed for later. No action.' },
    unreadAtFirstSight: false,
  },
];

/**
 * `MAIL_FIXTURE_DENSE=1` adds forty more messages to the inbox.
 *
 * A design cannot be judged against four short mails. This set is the density the console has to
 * survive: a table-heavy newsletter with the sender's own colours, an inline image whose bytes
 * nothing serves, a six-thousand-word plain-text mail, a 120-character subject, fourteen recipients
 * with nine attachments, a non-Latin subject and body, quoted reply history, and a long tail of
 * ordinary mail. It is a FLAG because the read, write and task specs count on the four.
 *
 * Everything here is invented, under `example.com`, and nothing resolves.
 */
const dense = process.env.MAIL_FIXTURE_DENSE === '1';
if (dense) MESSAGES.push(...denseMessages(), ...denseExtras());

/**
 * `MAIL_FIXTURE_DEEP=1` adds sixty OLDER inbox messages, forty-five of them unread.
 *
 * Its own flag, on top of dense, because it is the only shape that makes an unread filter falsifiable:
 * the dense inbox is 43 rows with 8 unread, which fits inside one 50-row page, so a filter applied in
 * the browser and a filter applied in SQL produce the same list and no test can tell them apart. With
 * this on, the inbox is 103 rows and 53 unread: the first page holds 13 of those 53, the unread list
 * itself needs two pages, and both numbers are things a run can check. The design spec counts the 43,
 * which is why this is not folded into dense.
 */
const deep = process.env.MAIL_FIXTURE_DEEP === '1';
if (dense && deep) MESSAGES.push(...deepTail());

/**
 * The dense set also keeps the two folders a work account always has and this fixture had not: a
 * DRAFTS folder (the provider holding drafts written on another device, next to Walnut's own) and a
 * JUNK folder, which is empty and is here for its POSITION. The server lists folders inbox first
 * then by name, so Junk is what makes "the merged Drafts row sits where the provider's folder was"
 * a claim a run can fail. Dense only: the other specs count the rows of the plain set.
 *
 * No new folder for the deep tail: it rides the INBOX in `MESSAGES` like everything else, so
 * `listMailboxes` counts it, and the mailbox row's own unread number (the provider's) is exactly what
 * the console's list header now reads.
 *
 * `declared` is the one exception to counting: with the deep flag on, Junk reports five figures of mail
 * and none of it cached, which is what a real spam folder looks like and the only way a run can see a
 * badge that no longer says "99+". A number that wide has to fit the folder row without clipping or
 * wrapping, in both engines, and no amount of cached fixture mail would produce it.
 */
/**
 * A folder this server LISTS and then refuses to poll, which every real IMAP account has.
 *
 * Gmail lists a name for every label that only exists as a parent, plus its own `[Gmail]` namespace
 * node, and answers `NO` to anybody who tries to open one. That refusal used to escape the sync
 * loop's container loop, which ended the whole sweep: on a real account with 67 folders the twelfth
 * in order was one of these, so the 55 after it were never polled once and the console showed each
 * of their true sizes over an empty message list.
 *
 * Its own flag, because it changes what the folder list contains and the other specs count those
 * rows. `declared` gives it a size, which is the half the console CAN read: the bug is only visible
 * when a folder has a number and no mail.
 */
const coldFolder = process.env.MAIL_FIXTURE_COLD_FOLDER === '1';

/**
 * `PW_MAIL_CTX=1`: the shape a ROW MENU has to be graded against.
 *
 * Two accounts adopted with no dialog (this provider, which can mark read and send, and the
 * inbound-only one below, which can do neither), so the capability gate on a menu item is a real
 * question with two real answers in one window. It also adds the folders a menu acts on that the
 * small set had none of: a sent folder, the provider's own Drafts folder, and five folders with a
 * size and no cached mail, one per outcome the on-demand fetch can answer with.
 *
 * The fetch OUTCOMES are canned by the fixture server, not by this provider: `stopped` and
 * `unknown-mailbox` come from the plugin's own bookkeeping and `running` is a ten-second deadline,
 * so producing them here would mean sleeping inside the sync queue and holding every other folder
 * behind it. `ctx/fetch-ok` is the one that goes through the real path.
 */
const ctx = process.env.PW_MAIL_CTX === '1';

/**
 * `PW_MAIL_UNSUB=1`: the four ways a message can offer (or not offer) a way off a mailing list.
 *
 * One row per rung of the ladder, because the row menu's `Unsubscribe` says something different about
 * each and there is no other way to get all four on one screen: a one-click POST the sender invited, a
 * mail to the list, a link that only exists in the footer, and a message from a person with nothing at
 * all. Adopted on BOTH accounts (see `UNSUB_INBOUND_MESSAGES`), so the SMTP gate is a real question with
 * two real answers in one window — the mailto rung is the one rung that needs outgoing mail, and an
 * account without it must offer a disabled row with the reason rather than a click that 409s.
 *
 * A fifth row (`UNSUB_MAILTO_SIBLING`) shares the mailto row's `List-Id`, because the ledger remembers a
 * LIST: leaving one issue has to show on the others, and that is only provable with a second issue.
 *
 * Its own flag, not a default, because the read and gate specs count messages and providers.
 */
const unsub = process.env.PW_MAIL_UNSUB === '1';

/** Fixed ids, so a spec can name any of the rows without scraping the list. */
const UNSUB_ONE_CLICK = 'INBOX:8:1';
const UNSUB_MAILTO = 'INBOX:8:2';
const UNSUB_FOOTER = 'INBOX:8:3';
const UNSUB_NONE = 'INBOX:8:4';
/**
 * A SECOND issue of the same list as `UNSUB_MAILTO`, and the only reason it exists.
 *
 * The ledger remembers a LIST, not a message, so leaving one issue has to show on every other issue
 * still in the cache. One row per list can never prove that: the row somebody clicked is `scope:
 * 'message'` and says which rung did it, and only a sibling can say `You unsubscribed from this list on
 * …`. Same `listId`, same mailto, a different id and a different subject.
 */
const UNSUB_MAILTO_SIBLING = 'INBOX:8:5';

/** The list host. `.invalid` (RFC 2606); nothing here resolves and no spec lets a socket out. */
const UNSUB_HOST = 'lists.example.invalid';

/**
 * The rows, newest first so the order on screen is the order written here.
 *
 * The footer one deliberately carries NO headers: its only way out is the https anchor in its own
 * markup, which is the path an account whose transport hands over no headers ever has, and the base has
 * to find it while storing the body.
 */
function unsubMessages() {
  return [
    {
      messageId: UNSUB_ONE_CLICK,
      rfcMessageId: '<weekly-1@' + UNSUB_HOST + '>',
      mailboxId: 'INBOX',
      from: { name: 'Marina Weekly', address: 'weekly@' + UNSUB_HOST },
      to: [{ address: 'ctx-writer@example.invalid' }],
      subject: 'Marina Weekly, issue 41',
      snippet: 'Moorings, tides and one heron.',
      sentAt: now - 1 * HOUR,
      attachments: [],
      body: { format: 'text', text: 'Moorings, tides and one heron.\n\nThe Marina Weekly' },
      unreadAtFirstSight: false,
      listUnsubscribe: {
        https: ['https://' + UNSUB_HOST + '/u/one-click'],
        oneClick: true,
        listId: 'weekly.' + UNSUB_HOST,
      },
    },
    {
      messageId: UNSUB_MAILTO,
      rfcMessageId: '<monthly-2@' + UNSUB_HOST + '>',
      mailboxId: 'INBOX',
      from: { name: 'Moorings Monthly', address: 'monthly@' + UNSUB_HOST },
      to: [{ address: 'ctx-writer@example.invalid' }],
      subject: 'Moorings Monthly, issue 2',
      snippet: 'Winter rates and the slipway.',
      sentAt: now - 2 * HOUR,
      attachments: [],
      body: { format: 'text', text: 'Winter rates and the slipway.\n\nMoorings Monthly' },
      unreadAtFirstSight: false,
      listUnsubscribe: {
        mailto: ['mailto:leave@' + UNSUB_HOST + '?subject=unsubscribe%20k9'],
        oneClick: false,
        listId: 'monthly.' + UNSUB_HOST,
      },
    },
    {
      messageId: UNSUB_FOOTER,
      rfcMessageId: '<tides-3@' + UNSUB_HOST + '>',
      mailboxId: 'INBOX',
      from: { name: 'Tides Digest', address: 'tides@' + UNSUB_HOST },
      to: [{ address: 'ctx-writer@example.invalid' }],
      subject: 'Tides Digest, issue 3',
      snippet: 'Spring tides on the eleventh.',
      sentAt: now - 3 * HOUR,
      attachments: [],
      body: {
        format: 'both',
        text: 'Spring tides on the eleventh.',
        html: '<p>Spring tides on the eleventh.</p>'
          + '<p><a href="https://' + UNSUB_HOST + '/u/footer">Unsubscribe</a>'
          + ' &middot; <a href="https://' + UNSUB_HOST + '/browser">View in browser</a></p>',
      },
      unreadAtFirstSight: false,
    },
    {
      messageId: UNSUB_NONE,
      rfcMessageId: '<lunch-4@example.invalid>',
      mailboxId: 'INBOX',
      from: { name: 'Priya', address: 'priya@example.invalid' },
      to: [{ address: 'ctx-writer@example.invalid' }],
      subject: 'Lunch on Thursday?',
      snippet: 'Either day works for me.',
      sentAt: now - 4 * HOUR,
      attachments: [],
      body: { format: 'text', text: 'Either day works for me.\n\nPriya' },
      unreadAtFirstSight: false,
    },
    {
      messageId: UNSUB_MAILTO_SIBLING,
      rfcMessageId: '<monthly-1@' + UNSUB_HOST + '>',
      mailboxId: 'INBOX',
      from: { name: 'Moorings Monthly', address: 'monthly@' + UNSUB_HOST },
      to: [{ address: 'ctx-writer@example.invalid' }],
      subject: 'Moorings Monthly, issue 1',
      snippet: 'The slipway reopens on the fourth.',
      sentAt: now - 25 * HOUR,
      attachments: [],
      body: { format: 'text', text: 'The slipway reopens on the fourth.\n\nMoorings Monthly' },
      unreadAtFirstSight: false,
      listUnsubscribe: {
        mailto: ['mailto:leave@' + UNSUB_HOST + '?subject=unsubscribe%20k9'],
        oneClick: false,
        listId: 'monthly.' + UNSUB_HOST,
      },
    },
  ];
}

const CTX_FETCH_FOLDERS = ['ctx-fetch-ok', 'ctx-fetch-running', 'ctx-fetch-unknown', 'ctx-fetch-stopped', 'ctx-fetch-failed'];

const MAILBOXES = [
  { mailboxId: 'INBOX', name: 'Inbox', role: 'inbox' },
  { mailboxId: 'Archive', name: 'Archive', role: 'archive' },
  ...(ctx ? [
    { mailboxId: 'Sent', name: 'Sent', role: 'sent' },
    { mailboxId: 'Drafts', name: 'Drafts', role: 'drafts' },
    // A size the mailbox list knows and no mail in the cache: the state every folder past the
    // sweep's budget is in, which is the only state "fetch this folder now" is about.
    ...CTX_FETCH_FOLDERS.map((mailboxId) => ({
      mailboxId,
      name: mailboxId,
      role: 'other',
      declared: { total: 214, unread: 3 },
    })),
  ] : []),
  ...(dense ? [
    { mailboxId: 'Drafts', name: 'Drafts', role: 'drafts' },
    {
      mailboxId: 'Junk',
      name: 'Junk',
      role: 'spam',
      ...(deep ? { declared: { total: 45_231, unread: 12_345 } } : {}),
    },
  ] : []),
  // Named to sort FIRST among the non-inbox folders, which is the whole point: the sweep visits
  // them inbox-first then by name, so a refusal here is a refusal with folders queued behind it.
  // Sorted last it would prove nothing, since there would be nothing left for it to starve.
  ...(coldFolder ? [{
    mailboxId: 'Aged',
    name: 'Aged',
    role: 'other',
    declared: { total: 1962, unread: 2 },
  }] : []),
];

/** The folder above, and the only mailbox this server ever refuses. */
const COLD_MAILBOX = 'Aged';

/**
 * The three rows the CTX shape adds, one per folder a menu item names.
 *
 * `Sent:1:9` is a row in a SENT list, where the read toggle is legal and Reply is the odd one: a
 * menu built from a row in the wrong list is the mistake this row exists to catch. The one in
 * `ctx-fetch-ok` is what makes a real on-demand fetch of that folder visibly add something.
 */
function ctxMessages() {
  return [
    {
      messageId: 'Sent:1:9',
      rfcMessageId: '<sent-9@example.invalid>',
      mailboxId: 'Sent',
      from: { name: 'Me', address: 'me@example.invalid' },
      to: [{ name: 'Priya', address: 'priya@example.invalid' }],
      subject: 'Pier repairs, dates',
      snippet: 'Either of the first two weeks works.',
      sentAt: now - 3 * HOUR,
      attachments: [],
      body: { format: 'text', text: 'Either of the first two weeks works.\n\nMe' },
      unreadAtFirstSight: false,
    },
    {
      // A draft the PROVIDER holds (another device wrote it), which is the fifth dimension of the row
      // menu: no read toggle, no reply, `Continue editing` instead of `Open message`. The folder existed
      // in this shape from the start and had no rows, so that branch could only be graded in unit tests.
      messageId: 'Drafts:1:4',
      rfcMessageId: '<draft-4@example.invalid>',
      mailboxId: 'Drafts',
      from: { name: 'Me', address: 'me@example.invalid' },
      to: [{ name: 'Harbour office', address: 'office@example.invalid' }],
      subject: 'Mooring renewal, unsent',
      snippet: 'Left half written on the other machine.',
      sentAt: now - 5 * HOUR,
      attachments: [],
      body: { format: 'text', text: 'Left half written on the other machine.' },
      unreadAtFirstSight: false,
    },
    {
      messageId: 'ctx-fetch-ok:1:2',
      rfcMessageId: '<folder-2@example.invalid>',
      mailboxId: 'ctx-fetch-ok',
      from: { name: 'Ferry Notices', address: 'notices@example.invalid' },
      to: [{ address: 'me@example.invalid' }],
      subject: 'Timetable from the winter',
      snippet: 'Kept for the record.',
      sentAt: now - 30 * HOUR,
      attachments: [],
      body: { format: 'text', text: 'Kept for the record.' },
      unreadAtFirstSight: true,
    },
  ];
}

if (ctx) MESSAGES.push(...ctxMessages());
if (unsub) MESSAGES.push(...unsubMessages());

/** Read state, as a server holds it. Seeded from the canned envelopes. */
const seen = new Set(MESSAGES.filter((one) => !one.unreadAtFirstSight).map((one) => one.messageId));

/**
 * `PW_MAIL_READ_ELSEWHERE=1`: mail read on another device, reported the way a provider whose poll never
 * lists an old message again reports it (the Outlook shape).
 *
 * A spec names the messages it "read on the phone" in `<home>/mail-fixture-read-elsewhere.json`. From
 * then on the folder's own count leaves them out and `listUnread` does not name them, while the poll
 * keeps handing over the envelope it always did, so the unread reconcile is the ONLY thing that can
 * correct the cache. `listUnread` answers after `delayMs` (2500 unless the file says otherwise), which is
 * slower than a smart list waits for it: the production timing that left read mail on an open list.
 * Read from disk on every call so a running spec can change it.
 */
const readElsewhereOn = process.env.PW_MAIL_READ_ELSEWHERE === '1';
const READ_ELSEWHERE = path.join(process.env.OPEN_WALNUT_HOME || os.tmpdir(), 'mail-fixture-read-elsewhere.json');

function readElsewhere() {
  if (!readElsewhereOn) return { ids: new Set(), delayMs: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(READ_ELSEWHERE, 'utf8'));
    return { ids: new Set(raw.messageIds ?? []), delayMs: typeof raw.delayMs === 'number' ? raw.delayMs : 2500 };
  } catch {
    return { ids: new Set(), delayMs: 2500 };
  }
}

/** Unread on the server: not read here, and not read on another device either. */
function unreadOnServer(message, elsewhere) {
  return !seen.has(message.messageId) && !elsewhere.ids.has(message.messageId);
}

/** Accounts this provider has been given, which is what `listAccounts` answers with. */
const accounts = [];

function bytesOf(body) {
  return Buffer.byteLength(body.text ?? body.html ?? '', 'utf8');
}

function envelopeOf(message) {
  return {
    messageId: message.messageId,
    rfcMessageId: message.rfcMessageId,
    mailboxId: message.mailboxId,
    from: message.from,
    to: message.to,
    subject: message.subject,
    snippet: message.snippet,
    sentAt: message.sentAt,
    ...(message.sentAtHeader ? { sentAtHeader: message.sentAtHeader } : {}),
    flags: seen.has(message.messageId) ? ['\\Seen'] : [],
    attachments: message.attachments,
    bodyBytes: bytesOf(message.body),
    // Only when the row declares it. A transport that reports no List-Unsubscribe at all is the
    // ordinary case and must stay indistinguishable from one whose message really has none.
    ...(message.listUnsubscribe ? { listUnsubscribe: message.listUnsubscribe } : {}),
  };
}

function authError(message) {
  const error = new Error(message);
  error.code = 'auth';
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.code = 'not-found';
  return error;
}

/**
 * The refusal a folder nobody can open really arrives as.
 *
 * `unreachable` rather than `not-found`, deliberately, because that is the code the real one had and
 * the reason the bug existed: `not-found` was already handled inside the container's own loop, so a
 * refusal that mapped to it was contained. This one is the shape that escaped.
 */
function unreachable(message) {
  const error = new Error(message);
  error.code = 'unreachable';
  return error;
}

const spec = {
  id: 'fixture',
  label: 'Fixture Mail',
  capabilities: {
    search: false,
    watch: false,
    drafts: false,
    markRead: true,
    flags: false,
    threads: false,
    send: true,
    sendAsReply: true,
    bodies: 'both',
    attachments: 'metadata',
  },
  setup: {
    fields: [
      {
        name: 'address',
        label: 'Email address',
        kind: 'text',
        required: true,
        placeholder: 'you@example.invalid',
      },
      {
        name: 'token',
        label: 'App password',
        kind: 'password',
        required: true,
        help: 'This fixture accepts the word ok and refuses everything else.',
      },
      // The two fields a preset exists to fill. OPTIONAL, because `submit` below only ever
      // checks the token: the specs that add an account without touching them must keep working.
      { name: 'host', label: 'Mail server', kind: 'text', placeholder: 'mail.example.invalid' },
      { name: 'port', label: 'Port', kind: 'text', placeholder: '993' },
    ],
    /**
     * One known service, so the console's preset row is exercised without a network.
     *
     * The domain is deliberately NOT `example.invalid`: the specs add their account as
     * `alice@example.invalid`, and a preset matching that would fill the servers in the middle of
     * a flow whose subject is something else.
     */
    presets: [
      {
        id: 'fixturehost',
        label: 'Fixture Host',
        match: ['preset.invalid'],
        // 1143, NOT the 993 the field's placeholder shows. A preset value equal to the placeholder
        // is indistinguishable from nothing having happened, in the assertion and in the
        // screenshot alike. (The real IMAP presets fill no port at all: `submit` derives it.)
        values: { host: 'mail.preset.invalid', port: '1143' },
        help: 'Fixture Host wants an app password, never your main account password.',
        helpUrl: 'https://example.invalid/app-passwords',
        // The recipe, as a provider declares it. The middle step's scheme is REFUSED on purpose:
        // these urls come from a plugin and land in an href, so a `javascript:` step has to render
        // as plain text. A step with no url at all is the third shape the console must handle.
        steps: [
          { text: 'Open the security page', url: 'https://example.invalid/security' },
          { text: 'Create an app password named Walnut', url: 'javascript:alert(1)' },
          { text: 'Paste the 16 letters into App password' },
        ],
      },
    ],
    async submit(values) {
      if (values.token !== 'ok') {
        throw authError('The mail server refused that token.');
      }
      const address = values.address || 'me@example.invalid';
      const account = {
        accountId: `fixture:${address}`,
        providerId: 'fixture',
        displayName: 'Fixture Mail',
        address,
        state: 'active',
      };
      if (!accounts.some((one) => one.accountId === account.accountId)) accounts.push(account);
      return account;
    },
  },
  async listAccounts() {
    return accounts.map((one) => ({ ...one }));
  },
  async health() {
    return { state: 'ok', checkedAt: Date.now() };
  },
  async listMailboxes() {
    const elsewhere = readElsewhere();
    return MAILBOXES.map(({ declared, ...mailbox }) => {
      const held = MESSAGES.filter((one) => one.mailboxId === mailbox.mailboxId);
      return {
        ...mailbox,
        // Counted from what this server holds, unless the folder declares its own figures (Junk).
        total: declared ? declared.total : held.length,
        unread: declared ? declared.unread : held.filter((one) => unreadOnServer(one, elsewhere)).length,
      };
    });
  },
  // Only with `PW_MAIL_READ_ELSEWHERE=1`, so every other spec keeps the poll-only provider it was written
  // against. Newest first, like a real unread search.
  ...(readElsewhereOn ? {
    async listUnread(_accountId, mailbox, limit) {
      const elsewhere = readElsewhere();
      if (elsewhere.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, elsewhere.delayMs));
      return MESSAGES
        .filter((one) => one.mailboxId === mailbox && unreadOnServer(one, elsewhere))
        .sort((a, b) => b.sentAt - a.sentAt)
        .slice(0, limit)
        .map(envelopeOf);
    },
  } : {}),
  async poll(_accountId, request) {
    if (coldFolder && request.mailbox === COLD_MAILBOX) {
      throw unreachable(`this server will not open ${request.mailbox}`);
    }
    const held = MESSAGES.filter((one) => one.mailboxId === request.mailbox);
    return {
      messages: held.map(envelopeOf),
      // One page, and a cursor that never moves: a second poll of an unchanged container has to
      // stay silent, which is what the base's event suppression reads.
      cursor: `${request.mailbox}:1:end`,
      more: false,
    };
  },
  async getBody(_accountId, messageId) {
    const message = MESSAGES.find((one) => one.messageId === messageId);
    if (!message) throw notFound(`no fixture message ${messageId}`);
    // RAW: the console sanitizes. A provider that pre-cleaned this would be testing itself.
    return { ...message.body, bytes: bytesOf(message.body) };
  },
  async markRead(_accountId, messageId, read) {
    if (!MESSAGES.some((one) => one.messageId === messageId)) {
      throw notFound(`no fixture message ${messageId}`);
    }
    if (read) seen.add(messageId);
    else seen.delete(messageId);
  },
  /**
   * Accept the message and write down exactly what arrived.
   *
   * The `idempotencyKey` is recorded too: it is `<draftId>:<revision>`, so a second send of one
   * approved revision would show up here as two rows with the same key, which is the failure the
   * whole ledger exists to prevent.
   */
  async send(accountId, mail, options) {
    const n = recordSend({
      accountId,
      to: mail.to,
      cc: mail.cc ?? [],
      bcc: mail.bcc ?? [],
      subject: mail.subject,
      bodyMarkdown: mail.bodyMarkdown,
      bodyHtml: mail.bodyHtml ?? '',
      inReplyTo: mail.inReplyTo ?? null,
      references: mail.references ?? [],
      idempotencyKey: options?.idempotencyKey ?? '',
      at: Date.now(),
    });
    return { providerMessageId: `<fixture-send-${n}@example.invalid>`, acceptedAt: Date.now() };
  },
  async removeAccount(accountId) {
    const at = accounts.findIndex((one) => one.accountId === accountId);
    if (at >= 0) accounts.splice(at, 1);
  },
};

/** Accounts of the read-only provider, kept apart from the sendable one's. */
const inboundAccounts = [];

/**
 * Rows for the account that can neither mark read nor send (`PW_MAIL_CTX=1`).
 *
 * One READ and one UNREAD, because the read toggle's label has to state what it would do to THAT row
 * and a fixture with only one kind lets a fixed word pass. This provider declares `markRead: false`,
 * so the item must not be drawn on either of them: the account is the control, not the subject.
 *
 * The unread one's body is refused, which is the case a reply started from a row has to survive: the
 * quote has nothing to quote, so no draft may be written.
 */
const INBOUND_MESSAGES = [
  {
    messageId: 'INBOX:2:11',
    rfcMessageId: '<notice-11@example.invalid>',
    mailboxId: 'INBOX',
    from: { name: 'Harbour Notices', address: 'harbour@example.invalid' },
    to: [{ address: 'reader@example.invalid' }],
    subject: 'Moorings closed on the sixth',
    snippet: 'The north pontoon is closed for a day.',
    sentAt: now - 4 * HOUR,
    attachments: [],
    text: 'The north pontoon is closed for a day.',
    seen: true,
  },
  {
    messageId: 'INBOX:2:12',
    rfcMessageId: '<notice-12@example.invalid>',
    mailboxId: 'INBOX',
    from: { name: 'Tide Tables', address: 'tides@example.invalid' },
    to: [{ address: 'reader@example.invalid' }],
    subject: 'Spring tides this month',
    snippet: 'Highest water is on the eleventh.',
    sentAt: now - 6 * HOUR,
    attachments: [],
    // No text at all: `getBody` refuses this one.
    text: null,
    seen: false,
  },
  // `PW_MAIL_UNSUB=1` only: a mailto-only newsletter on the account with NO outgoing mail. It is the
  // other half of the SMTP gate, and the only way to see it: the row must be disabled with the
  // can't-send reason rather than offering a click that could only ever fail at the transport.
  ...(unsub ? [{
    messageId: 'INBOX:2:13',
    rfcMessageId: '<harbour-news-13@' + UNSUB_HOST + '>',
    mailboxId: 'INBOX',
    from: { name: 'Harbour News', address: 'news@' + UNSUB_HOST },
    to: [{ address: 'ctx-reader@example.invalid' }],
    subject: 'Harbour News, issue 13',
    snippet: 'Dredging starts in March.',
    sentAt: now - 5 * HOUR,
    attachments: [],
    text: 'Dredging starts in March.',
    seen: true,
    listUnsubscribe: {
      mailto: ['mailto:leave@' + UNSUB_HOST],
      oneClick: false,
      listId: 'news.' + UNSUB_HOST,
    },
  }] : []),
];

/** The mailto-only row on the account that cannot send. Named so a spec need not scrape the list. */
export const UNSUB_NO_SMTP = 'INBOX:2:13';

/**
 * A second provider that reads mail and cannot send: an IMAP account with no SMTP settings, which
 * is the case `capabilities.send` exists for. Everything else about it is deliberately minimal.
 */
const inboundSpec = {
  id: 'inbound',
  label: 'Fixture Mail (inbound only)',
  capabilities: {
    search: false,
    watch: false,
    drafts: false,
    markRead: false,
    flags: false,
    threads: false,
    send: false,
    sendAsReply: false,
    bodies: 'text',
    attachments: 'none',
  },
  setup: {
    fields: [
      { name: 'address', label: 'Email address', kind: 'text', required: true },
    ],
    async submit(values) {
      const address = values.address || 'read-only@example.invalid';
      const account = {
        accountId: `inbound:${address}`,
        providerId: 'inbound',
        displayName: 'Fixture Mail (inbound only)',
        address,
        state: 'active',
      };
      if (!inboundAccounts.some((one) => one.accountId === account.accountId)) inboundAccounts.push(account);
      return account;
    },
  },
  async listAccounts() {
    return inboundAccounts.map((one) => ({ ...one }));
  },
  async health() {
    return { state: 'ok', checkedAt: Date.now() };
  },
  async listMailboxes() {
    const held = ctx || unsub ? INBOUND_MESSAGES : [];
    return [{
      mailboxId: 'INBOX',
      name: 'Inbox',
      role: 'inbox',
      total: held.length,
      unread: held.filter((one) => !one.seen).length,
    }];
  },
  async poll(_accountId, request) {
    const held = (ctx || unsub) && request.mailbox === 'INBOX' ? INBOUND_MESSAGES : [];
    return {
      messages: held.map((one) => ({
        messageId: one.messageId,
        rfcMessageId: one.rfcMessageId,
        mailboxId: one.mailboxId,
        from: one.from,
        to: one.to,
        subject: one.subject,
        snippet: one.snippet,
        sentAt: one.sentAt,
        flags: one.seen ? ['\\Seen'] : [],
        attachments: one.attachments,
        bodyBytes: one.text ? Buffer.byteLength(one.text, 'utf8') : 0,
        ...(one.listUnsubscribe ? { listUnsubscribe: one.listUnsubscribe } : {}),
      })),
      cursor: `${request.mailbox}:1:end`,
      more: false,
    };
  },
  async getBody(_accountId, messageId) {
    const message = ctx || unsub ? INBOUND_MESSAGES.find((one) => one.messageId === messageId) : null;
    if (!message || !message.text) throw notFound('the inbound fixture has no body for that message');
    return { format: 'text', text: message.text, bytes: Buffer.byteLength(message.text, 'utf8') };
  },
  async send() {
    const error = new Error('this account has no outgoing mail configured');
    error.code = 'unsupported';
    throw error;
  },
  async removeAccount(accountId) {
    const at = inboundAccounts.findIndex((one) => one.accountId === accountId);
    if (at >= 0) inboundAccounts.splice(at, 1);
  },
};

/**
 * The dense inbox: six shaped messages and thirty-four ordinary ones.
 *
 * Every string is local to this function, so the module can be read top to bottom without it, and
 * every timestamp is derived (never random) so two runs produce the same list and a screenshot can
 * be compared with the last one.
 */
function denseMessages() {
  const you = [{ name: 'You', address: 'you@example.com' }];
  const at = (hours) => now - hours * HOUR;

  const NEWSLETTER = [
    '<div style="font-family: Georgia, \'Times New Roman\', serif; color: #22223b">',
    '<h1 style="color: #3a0ca3; margin: 0 0 4px">Harbour Ferry Weekly</h1>',
    // A literal separator rather than `&middot;`: the plugin's snippet builder strips tags without
    // decoding entities, so the list row would show the escape instead of the character.
    '<p style="color: #4a4e69; margin: 0 0 18px">Issue 42 · timetable, fares, and the winter works</p>',
    '<img src="cid:masthead.42@fixture.example.com" alt="Harbour Ferry masthead" width="560" height="90">',
    '<h2 style="color: #7209b7">Timetable</h2>',
    '<table border="1" cellpadding="8" cellspacing="0" width="720" style="border-color: #dcdcea">',
    '<tr style="background: #f1f1fb"><th align="left">Route</th><th align="left">First</th>'
      + '<th align="left">Last</th><th align="left">Every</th><th align="left">Fare</th></tr>',
    ...[
      ['North Quay to Marina', '05:40', '23:10', '20 min', '2.40'],
      ['Marina to North Quay', '05:55', '23:25', '20 min', '2.40'],
      ['North Quay to Sandhill', '06:10', '22:40', '30 min', '3.10'],
      ['Sandhill to Marina', '06:35', '22:05', '30 min', '3.10'],
      ['Marina to Long Reef', '07:00', '21:30', '45 min', '4.60'],
      ['Long Reef to Sandhill', '07:25', '21:00', '45 min', '4.60'],
      ['Night service, all stops', '23:40', '01:20', '60 min', '5.20'],
      ['Sunday loop, all stops', '08:00', '20:00', '40 min', '3.80'],
    ].map(([route, first, last, every, fare]) => (
      `<tr><td>${route}</td><td>${first}</td><td>${last}</td><td>${every}</td><td>${fare}</td></tr>`
    )),
    '</table>',
    '<h2 style="color: #7209b7">Fares from the first of the month</h2>',
    '<table border="1" cellpadding="8" cellspacing="0" width="720" style="border-color: #dcdcea">',
    '<tr style="background: #f1f1fb"><th align="left">Ticket</th><th align="left">Now</th>'
      + '<th align="left">Then</th></tr>',
    ...[
      ['Single, short hop', '2.40', '2.55'],
      ['Single, full route', '4.60', '4.80'],
      ['Ten trip book', '21.00', '22.50'],
      ['Monthly pass', '68.00', '71.00'],
      ['Bicycle', '0.90', '1.00'],
      ['Child under twelve', 'free', 'free'],
    ].map(([ticket, before, after]) => `<tr><td>${ticket}</td><td>${before}</td><td>${after}</td></tr>`),
    '</table>',
    '<h3 style="color: #b5179e">Winter works</h3>',
    '<p>The Sandhill pontoon is lifted for repair between the ninth and the twenty-second. Boats'
      + ' berth at the temporary ramp beside the chandlery, which is a four minute walk south.</p>',
    '<p>Crews are on the pier from six in the morning. The waiting room stays open, the ticket'
      + ' window does not, so buy on board or use the machine at the top of the steps.</p>',
    '<p><img src="https://static.example.com/ferry-open.gif" width="1" height="1" alt=""></p>',
    '<p style="font-size: 12px; color: #8d99ae">You are on this list because you bought a monthly'
      + ' pass. Reply with the word stop and the list forgets you.</p>',
    '</div>',
  ].join('');

  const QUOTED_REPLY = [
    'Thursday morning works. I will bring the printed plan and the two spare keys.',
    '',
    'On Tue, 3 Jun 2026 at 09:12, Marta Silva <marta.silva@example.com> wrote:',
    '> Could we move the walkthrough to Thursday? The dock crew is only there',
    '> before noon, and I would rather not do this twice.',
    '>',
    '> On Mon, 2 Jun 2026 at 17:40, Owen Blake <owen.blake@example.com> wrote:',
    '> > Wednesday afternoon is booked for the crane, so any day but that one.',
    '> > The plan is in the folder, second drawer.',
  ].join('\n');

  const CJK_BODY = [
    '各位同事：',
    '',
    '冬季施工從本月九日開始，沙丘碼頭的浮橋會吊起維修，臨時斜坡在船具店旁邊，步行約四分鐘。',
    '售票窗口不開，請上船購票或使用階梯頂端的機器。',
    '',
    'お知らせ: 冬季工事の期間中、夜間の便は一時間おきになります。ご不便をおかけします。',
    '',
    '謝謝，',
    '林 家瑜',
  ].join('\n');

  const wide = [
    'Please look over the winter timetable before Friday so the print shop has a whole day',
    'to set it. The fares table is the one that changed, and the night service is the one',
    'everybody asks about.',
    '',
    'The pontoon lift is booked, the crane is booked, and the chandlery has agreed to the',
    'temporary ramp. Nothing else is settled.',
  ].join('\n');

  const shaped = [
    {
      messageId: 'INBOX:1:120',
      from: { name: 'Harbour Ferry Weekly', address: 'weekly@example.com' },
      to: you,
      subject: 'Harbour Ferry Weekly, issue 42: winter timetable and the new fares',
      snippet: 'Issue 42: timetable, fares, and the winter works. The Sandhill pontoon is lifted for repair between the ninth and the twenty-second.',
      sentAt: at(3),
      attachments: [{ id: '2', filename: 'winter-timetable.pdf', mimeType: 'application/pdf', bytes: 284_517 }],
      body: { format: 'html', html: NEWSLETTER },
      unreadAtFirstSight: true,
    },
    {
      messageId: 'INBOX:1:119',
      from: { name: 'Priya Raman', address: 'priya.raman@example.com' },
      to: you,
      subject: 'The long version of the harbour report, as promised',
      snippet: 'Everything we went through on the pier, written out, with the links at the end of each part.',
      sentAt: at(4),
      attachments: [],
      body: { format: 'text', text: longPlainBody() },
    },
    {
      messageId: 'INBOX:1:118',
      from: { name: 'Sandhill Pontoon Works Coordination Group', address: 'works@example.com' },
      to: you,
      subject: 'Winter works on the Sandhill pontoon, the temporary ramp beside the chandlery, and what the crews need from the ticket office before the ninth',
      snippet: 'The pontoon is lifted on the ninth. The temporary ramp opens the same morning and the ticket window stays shut all month.',
      sentAt: at(6),
      attachments: [],
      body: { format: 'text', text: wide },
      unreadAtFirstSight: true,
    },
    {
      messageId: 'INBOX:1:117',
      from: { name: 'Owen Blake', address: 'owen.blake@example.com' },
      to: [
        ...you,
        ...[
          'marta.silva', 'priya.raman', 'jonas.holm', 'aiko.tanaka', 'noor.haddad', 'tomas.vega',
          'ruth.okafor', 'ines.duarte', 'kai.lindberg', 'sofia.marek', 'dmitri.ivanov', 'lucia.ferrer',
          'hannah.wolfe',
        ].map((one) => ({ address: `${one}@example.com` })),
      ],
      cc: [{ name: 'Dock Office', address: 'dock.office@example.com' }],
      subject: 'Everything the crane crew signed off, in nine files',
      snippet: 'Attached: the lift plan, the two surveys, the fare table, the ramp drawing, and the four photographs.',
      sentAt: at(7),
      attachments: [
        { id: '2', filename: 'lift-plan-final.pdf', mimeType: 'application/pdf', bytes: 1_204_880 },
        { id: '3', filename: 'survey-north-quay.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 48_112 },
        { id: '4', filename: 'survey-sandhill.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: 51_884 },
        { id: '5', filename: 'fares-from-the-first.csv', mimeType: 'text/csv', bytes: 2_104 },
        { id: '6', filename: 'temporary-ramp-drawing-revision-c.png', mimeType: 'image/png', bytes: 903_221 },
        { id: '7', filename: 'pontoon-underside.jpg', mimeType: 'image/jpeg', bytes: 2_418_007 },
        { id: '8', filename: 'pontoon-cleat.jpg', mimeType: 'image/jpeg', bytes: 1_902_664 },
        { id: '9', filename: 'notes-from-the-walk.docx', mimeType: 'application/msword', bytes: 22_940 },
        { id: '10', filename: 'photographs.zip', mimeType: 'application/zip', bytes: 7_331_002 },
      ],
      body: { format: 'text', text: 'All nine are in the folder as well, in case the mail refuses them.' },
    },
    {
      messageId: 'INBOX:1:116',
      from: { name: '林 家瑜', address: 'chia.yu.lin@example.com' },
      to: you,
      subject: '冬季施工安排與夜間班次調整のお知らせ',
      snippet: '冬季施工從本月九日開始，沙丘碼頭的浮橋會吊起維修。',
      sentAt: at(8),
      attachments: [{ id: '2', filename: '冬季施工計畫.pdf', mimeType: 'application/pdf', bytes: 143_220 }],
      body: { format: 'text', text: CJK_BODY },
      unreadAtFirstSight: true,
    },
    {
      messageId: 'INBOX:1:115',
      from: { name: 'Marta Silva', address: 'marta.silva@example.com' },
      to: [...you, { address: 'owen.blake@example.com' }],
      subject: 'Re: Dock walkthrough on Thursday',
      snippet: 'Thursday morning works. I will bring the printed plan and the two spare keys.',
      sentAt: at(9),
      attachments: [],
      body: { format: 'text', text: QUOTED_REPLY },
    },
  ];

  const senders = [
    ['Jonas Holm', 'jonas.holm'], ['Aiko Tanaka', 'aiko.tanaka'], ['Noor Haddad', 'noor.haddad'],
    ['Tomas Vega', 'tomas.vega'], ['Ruth Okafor', 'ruth.okafor'], ['Ines Duarte', 'ines.duarte'],
    ['Kai Lindberg', 'kai.lindberg'], ['Sofia Marek', 'sofia.marek'], ['Lucia Ferrer', 'lucia.ferrer'],
    ['Hannah Wolfe', 'hannah.wolfe'], ['Ferry Ticket Office', 'tickets'], ['Chandlery', 'chandlery'],
  ];
  const subjects = [
    'Crane slot moved to the afternoon', 'Two spare keys for the waiting room',
    'Fare machine at the top of the steps', 'Night service, one boat an hour',
    'Bicycle racks on the Marina ramp', 'Print shop wants the tables by Friday',
    'Sunday loop, four crews or five', 'Life jackets counted and signed',
    'Waiting room heater, again', 'Pontoon paint arrived early',
    'Sandhill steps are slippery at low water', 'Timetable proof, second pass',
    'Long Reef mooring fees for the quarter', 'Radio check missed on the night boat',
    'Ramp handrail bolts', 'Ticket book stock is down to eleven',
    'Lost property, one green coat',
  ];
  const filler = [];
  for (let index = 0; index < 34; index += 1) {
    const [name, local] = senders[index % senders.length];
    const subject = subjects[index % subjects.length];
    const day = index + 1;
    filler.push({
      messageId: `INBOX:1:${100 - index}`,
      from: { name, address: `${local}@example.com` },
      to: you,
      subject: index % 7 === 3 ? `Re: ${subject}` : subject,
      snippet: `${subject}. Nothing needed today unless the weather turns.`,
      sentAt: now - day * 24 * HOUR - (index % 5) * HOUR,
      attachments: index % 6 === 2
        ? [{ id: '2', filename: `note-${day}.pdf`, mimeType: 'application/pdf', bytes: 12_000 + index * 511 }]
        : [],
      body: {
        format: 'text',
        text: `${subject}.\n\nThe crews are on the pier from six. Details are on the board`
          + ` beside the ticket window, and the plan is at https://example.com/harbour/plan-${day}.`,
      },
      unreadAtFirstSight: index % 11 === 1,
    });
  }

  return [...shaped, ...filler].map((message) => ({
    rfcMessageId: `<${message.messageId.replace(/:/g, '-')}@example.com>`,
    mailboxId: 'INBOX',
    sentAtHeader: new Date(message.sentAt).toUTCString(),
    unreadAtFirstSight: false,
    ...message,
  }));
}

/**
 * What the dense set holds outside the inbox: two drafts in the PROVIDER's Drafts folder, as a
 * phone or a webmail tab leaves them, and one unread mail in Archive.
 *
 * The drafts are READ (a draft is not unread mail), so their folder carries no badge, and their
 * subjects are deliberately unlike any inbox subject, because the specs pick rows by their words.
 * They open in the reader like any other cached message, since that folder is read only here.
 *
 * The Archive mail is the SMALL folder with something unread in it: "only unread" hiding every row
 * is a state the console has to answer well, and a folder with one unread mail is the only way a
 * run reaches it by reading mail rather than by forty clicks.
 */
function denseExtras() {
  const me = { name: 'You', address: 'you@example.com' };
  return [
    {
      messageId: 'Archive:1:5',
      rfcMessageId: '<archive-5@example.com>',
      mailboxId: 'Archive',
      from: { name: 'Ines Duarte', address: 'ines.duarte@example.com' },
      to: [me],
      subject: 'Filed: the mooring fee receipts',
      snippet: 'Filed for the quarter. Nothing needed unless the auditor asks.',
      sentAt: now - 20 * 24 * HOUR,
      sentAtHeader: new Date(now - 20 * 24 * HOUR).toUTCString(),
      attachments: [],
      body: { format: 'text', text: 'Filed for the quarter. Nothing needed unless the auditor asks.' },
      unreadAtFirstSight: true,
    },
    {
      messageId: 'Drafts:1:7',
      rfcMessageId: '<draft-7@example.com>',
      mailboxId: 'Drafts',
      from: me,
      to: [{ name: 'Marta Silva', address: 'marta.silva@example.com' }],
      subject: 'Started on the pontoon handover notes',
      snippet: 'Half written on the train. The ramp measurements are still missing.',
      sentAt: now - 30 * HOUR,
      sentAtHeader: new Date(now - 30 * HOUR).toUTCString(),
      attachments: [],
      body: {
        format: 'text',
        text: 'Half written on the train.\n\nThe ramp measurements are still missing, and the'
          + ' chandlery has not confirmed the temporary berth.',
      },
      unreadAtFirstSight: false,
    },
    {
      messageId: 'Drafts:1:6',
      rfcMessageId: '<draft-6@example.com>',
      mailboxId: 'Drafts',
      from: me,
      to: [{ name: 'Ferry Ticket Office', address: 'tickets@example.com' }],
      subject: 'Question about the ten trip book, unfinished',
      snippet: 'Do the old books stay valid after the fares change?',
      sentAt: now - 52 * HOUR,
      sentAtHeader: new Date(now - 52 * HOUR).toUTCString(),
      attachments: [],
      body: {
        format: 'text',
        text: 'Do the old ten trip books stay valid after the fares change on the first?',
      },
      unreadAtFirstSight: false,
    },
  ];
}

/**
 * Sixty older inbox messages, forty-five unread: the tail an unread filter has to be able to reach.
 *
 * Every one of them is older than the whole dense set (which stops at 34 days), so the list order is
 * the dense 43 followed by these in index order, and the arithmetic a spec asserts is stable: unread
 * where the index is not a multiple of four, which is 45 of 60 and leaves 5 unread among the seven that
 * land on the first page. Inside the retention window (180 days) by construction, or the poll would
 * cache them and the sweep would drop them again in the same tick.
 *
 * The ids sit in their own thousand so they cannot collide with the dense set's, and the subjects are
 * numbered because the specs pick a row by its words: `Older harbour note 45` is unread and past the
 * first page, which is the row that proves the filter reached mail the browser never had.
 */
function deepTail() {
  const you = [{ name: 'You', address: 'you@example.com' }];
  const senders = [
    ['Tide Desk', 'tides'], ['Harbour Master', 'harbour.master'], ['Sandhill Crew', 'sandhill'],
    ['Long Reef Office', 'long.reef'], ['Chandlery', 'chandlery'],
  ];
  const topics = [
    'Tide table for the week', 'Slipway booking confirmed', 'Fuel dock hours',
    'Mooring inspection notes', 'Weather board replaced', 'Night crew rota',
    'Handrail paint order', 'Ticket machine receipt roll',
  ];
  const out = [];
  for (let index = 0; index < 60; index += 1) {
    const [name, local] = senders[index % senders.length];
    const topic = topics[index % topics.length];
    const sentAt = now - (40 + index) * 24 * HOUR - (index % 7) * HOUR;
    out.push({
      messageId: `INBOX:1:2${String(index).padStart(3, '0')}`,
      rfcMessageId: `<older-${index}@example.com>`,
      mailboxId: 'INBOX',
      from: { name, address: `${local}@example.com` },
      to: you,
      subject: `Older harbour note ${index}`,
      snippet: `${topic}. Filed from the office, nothing needed today.`,
      sentAt,
      sentAtHeader: new Date(sentAt).toUTCString(),
      attachments: [],
      body: { format: 'text', text: `${topic}.\n\nFiled from the office. Nothing needed today.` },
      unreadAtFirstSight: index % 4 !== 0,
    });
  }
  return out;
}

/**
 * Six thousand words of prose with links in it, built rather than pasted.
 *
 * Deterministic on purpose (no random): the reader's screenshots are compared between runs and
 * between engines, so the same words have to land in the same place every time.
 */
function longPlainBody() {
  const words = ('harbour ferry timetable pontoon crane fare ramp chandlery quay marina sandhill reef'
    + ' crew mooring tide slipway handrail waiting room ticket machine winter morning boat pier'
    + ' survey drawing folder plan notice board weather').split(' ');
  const paragraphs = [];
  let made = 0;
  let cursor = 0;
  let part = 1;
  while (made < 6000) {
    const sentences = [];
    for (let line = 0; line < 4; line += 1) {
      const length = 12 + ((cursor + line) % 9);
      const picked = [];
      for (let index = 0; index < length; index += 1) {
        picked.push(words[(cursor + index * 3) % words.length]);
        cursor += 1;
      }
      made += picked.length;
      sentences.push(`${picked.join(' ')}.`);
    }
    paragraphs.push(sentences.join(' '));
    if (paragraphs.length % 6 === 0) {
      paragraphs.push(`Part ${part} is written up at https://example.com/harbour/part-${part}`);
      part += 1;
      made += 8;
    }
  }
  return `Everything from the pier, written out.\n\n${paragraphs.join('\n\n')}\n\nPriya`;
}

/** The two accounts `PW_MAIL_CTX=1` adopts. Ids fixed, so a spec can name either one. */
export const CTX_WRITER = 'fixture:ctx-writer@example.invalid';
export const CTX_READER = 'inbound:ctx-reader@example.invalid';

/**
 * The same spec with no setup fields, which is what makes the base adopt its accounts at
 * registration (`(spec.setup?.fields?.length ?? 0) === 0`).
 *
 * A row menu spec needs two accounts on screen, and driving the add-an-account dialog twice first is
 * not what it is about. `listAccounts` is already the answer to adoption, so the accounts are seeded
 * into the same arrays `submit` would have pushed them into.
 */
function adopted(one) {
  // An EMPTY `fields` array, not a missing `setup`: the base requires the object itself
  // (`provider-registry.ts` refuses a spec without `setup.fields` + `setup.submit`, so deleting it
  // made registration throw and `PW_MAIL_CTX=1` install no accounts at all), and it is the empty
  // `fields` that makes it adopt what `listAccounts` already answers with.
  return {
    ...one,
    setup: {
      fields: [],
      submit: async () => { throw new Error('this fixture provider adopts its accounts instead'); },
    },
  };
}

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  // `PW_MAIL_UNSUB=1` wants the same two adopted accounts `PW_MAIL_CTX=1` does, for the same reason: the
  // capability gate on a menu item is only a real question when two accounts disagree about it on one
  // screen. The two flags therefore share this branch, and each adds its own rows above.
  if (ctx || unsub) {
    accounts.push({
      accountId: CTX_WRITER,
      providerId: 'fixture',
      displayName: 'Fixture Mail',
      address: 'ctx-writer@example.invalid',
      state: 'active',
    });
    inboundAccounts.push({
      accountId: CTX_READER,
      providerId: 'inbound',
      displayName: 'Fixture Mail (inbound only)',
      address: 'ctx-reader@example.invalid',
      state: 'active',
    });
    const both = [base.registerProvider(adopted(spec)), base.registerProvider(adopted(inboundSpec))];
    return { dispose: () => { for (const handle of both) handle.dispose(); } };
  }
  const handles = [base.registerProvider(spec)];
  if (process.env.PW_MAIL_INBOUND_PROVIDER === '1') handles.push(base.registerProvider(inboundSpec));
  // Returning the Disposable is how a provider hands ownership to the loader: turning this
  // plugin off detaches the provider live, with the base never knowing who registered it.
  return { dispose: () => { for (const handle of handles) handle.dispose(); } };
}
