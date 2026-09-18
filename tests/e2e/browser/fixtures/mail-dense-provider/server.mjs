/**
 * Two mail accounts at PRODUCTION density, for the smart-mailbox sidebar.
 *
 * Installed into the browser fixture's throwaway home the documented author way (a directory in
 * `plugins/` whose manifest declares `dependencies: { mail }`), and it declares NO setup fields, so the
 * base adopts both accounts the moment it registers: a spec that needs 70 folders on screen should not
 * have to drive an add-an-account dialog twice first.
 *
 * Every name here is invented. Addresses are `*.invalid` (RFC 2606) and nothing resolves.
 *
 * The shape is copied from the real cache this slice was measured against, because every number the
 * sidebar prints is only interesting at that density:
 *
 * - Account A has 64 folders: 6 roles and 58 ordinary labels, alphabetically INTERLEAVED with the role
 *   folders (the server orders inbox first, then by name), which is what buries `Sent` and `Archive` in
 *   the flat list this slice exists to collapse.
 * - Account B has 6 folders and no ordinary labels at all, so one account has a tail and the other does
 *   not, in one screenshot.
 * - The two accounts spell the same roles with DIFFERENT ids AND different names (`INBOX` against
 *   `inbox`, `Archive` against `Archived`, `Sent` against `Sent Mail`, `Trash` against `Bin`, and B's sent
 *   folder id is 90 characters). Those names also SORT differently, so the server's own order (inbox
 *   first, then by name) hands the two accounts the same six roles in two different orders, which is what
 *   the sidebar has to normalise. A merged list built from mailbox ids rather than from
 *   (account, mailbox) pairs mixes folders together, and a row that prints its mailbox id instead of its
 *   account name prints 90 characters of noise.
 * - A's inbox has ZERO unread and B's has 7, so the interesting number is never the first account's.
 * - A's Archive declares 177 unread, B's Junk 37 and B's Trash 2,609: the roles nobody triages carry the
 *   biggest numbers in the pane, which is what buried the smart row's own count on the real install.
 * - B's inbox row declares unread 7 while its cached rows hold 18 unread: the provider-count against
 *   cached-count divergence the merged header has to explain rather than hide.
 * - Six of A's labels hold STALE unread (55, 47, 40, 28, 28, 2, adding to 200) and receive nothing during
 *   a session, which is the case that decides promotion by arrival instead of by unread.
 * - One pair of messages shares a message id across the two accounts with different senders and
 *   subjects, and one group of three messages shares a second across accounts.
 *
 * The collapsed tail has ONE label with cached mail in it, `harbour/label/receipts` (6 messages, 2 of
 * them unread). A spec that wants to start INSIDE the collapsed tail seeds the sidebar preference before
 * the app boots (`walnut.mail.sidebar.v1`, field `selected`) with that pair: the row then has to be
 * visible and selected on the first frame rather than hidden behind its own collapse row.
 *
 * Flags, each off by default so the default really is the measured shape:
 *   PW_MAIL_DENSE_AUTH=1       account B is `auth-required` (its cached mail still reads)
 *   PW_MAIL_DENSE_NO_DRAFTS=1  account B has no provider Drafts folder (the Walnut row is still there)
 *   PW_MAIL_DENSE_TAIL_ONE=1   account B gains ONE ordinary label with unread (the singular copy)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Fixed, so a spec can assert an order and a page boundary. Well inside any retention window. */
const NOW = Date.now();

const A = 'dense:harbour';
const B = 'dense:marina';

const authRequired = process.env.PW_MAIL_DENSE_AUTH === '1';
const noProviderDrafts = process.env.PW_MAIL_DENSE_NO_DRAFTS === '1';
const tailOne = process.env.PW_MAIL_DENSE_TAIL_ONE === '1';

/** Where a send is recorded, exactly as the other mail fixture does it. */
const OUTBOX = path.join(process.env.OPEN_WALNUT_HOME || os.tmpdir(), 'mail-dense-sends.json');

function recordSend(entry) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(OUTBOX, 'utf8')); } catch { held = []; }
  held.push(entry);
  const staging = `${OUTBOX}.${process.pid}.tmp`;
  fs.writeFileSync(staging, JSON.stringify(held, null, 2));
  fs.renameSync(staging, OUTBOX);
  return held.length;
}

/**
 * B's sent folder id: EXACTLY 90 characters.
 *
 * One provider on the machine this fixture copies answers with 86 to 93 character folder ids, and the
 * merged list has a slot that used to print the raw mailbox id. Built and checked rather than typed, so
 * an edit cannot quietly shorten the evidence.
 */
function longId(prefix) {
  const padded = `${prefix}${'-segment'.repeat(12)}`.slice(0, 90);
  if (padded.length !== 90) throw new Error(`the long mailbox id must be 90 characters, got ${padded.length}`);
  return padded;
}

const B_SENT = longId('marina/all-mail/sent');

/**
 * Account A's 58 ordinary labels, alphabetically spread so the role folders land BETWEEN them.
 *
 * `Archive`, `Drafts`, `Sent`, `Spam` and `Trash` are sorted by the same name comparison, so labels
 * beginning with A, B to D, E to S, and T to W all have to exist for the flat list to look like the one
 * this slice collapses. Checked at load, because miscounting a hand-written list is silent.
 */
const LABELS = [
  'Accounts', 'Alerts', 'Appliances', 'Backups', 'Bills', 'Bookings', 'Calendar notes', 'Certificates',
  'Charity', 'Clubs', 'Contracts', 'Courses', 'Deliveries', 'Deposits', 'Devices', 'Digests',
  'Editors', 'Events', 'Expenses', 'Feedback', 'Ferries', 'Forums', 'Gardening', 'Groceries',
  'Guides', 'Hardware', 'Hosting', 'Insurance', 'Invoices', 'Jobs', 'Journals', 'Landlord',
  'Leases', 'Libraries', 'Licences', 'Mailing lists', 'Meetups', 'Newsletters', 'Notices', 'Offers',
  'Orders', 'Parking', 'Permits', 'Pledges', 'Receipts', 'Refunds', 'Renewals', 'Reports',
  'Reservations', 'Rewards', 'Schedules', 'Shipping', 'Statements', 'Subscriptions', 'Tickets',
  'Utilities', 'Vouchers', 'Warranties',
];
if (LABELS.length !== 58) throw new Error(`the dense fixture needs 58 labels, has ${LABELS.length}`);

/**
 * The six labels that hold unread nobody is going to read, and their counts.
 *
 * Copied from the real account (55, 47, 40, 28, 28, 2 = 200 unread across six archived labels). None of
 * them ever receives mail during a session, which is the whole case: a promotion rule keyed on unread
 * would lift all six out of the tail every single day.
 */
const STALE_UNREAD = {
  Newsletters: 55,
  Digests: 47,
  Offers: 40,
  Forums: 28,
  'Mailing lists': 28,
  Receipts: 2,
};

/** The one tail label with cached rows, so a selection can start inside the collapsed tail. */
const TAIL_WITH_MAIL = 'Receipts';

function labelId(name) {
  return `harbour/label/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Account A: 6 role folders and the 58 labels. `declared` is the provider's own count for a folder. */
function mailboxesA() {
  // The NAMES are this provider's own vocabulary, and one of them is the raw all-caps identifier a real
  // IMAP server answers with. Account B below spells the same roles differently again, which is the state
  // that made the sidebar name one role three ways: the group says All Inboxes, this account said INBOX
  // and the other said Inbox.
  // The names here sort into role order by luck (Archive, Drafts, Sent, Spam, Trash); B's sort into a
  // different one, so a spec can only hold one expected row order for both if the sidebar imposes it.
  const roles = [
    { mailboxId: 'INBOX', name: 'INBOX', role: 'inbox' },
    // Archive holds unread nobody is ever going to act on, which is the real shape: on the account this
    // fixture copies the loudest number in the sidebar was an Archive row's 177, three rows under the
    // eight on All Inboxes, and the second account's Trash carried 2,609.
    { mailboxId: 'Archive', name: 'Archive', role: 'archive', declared: { total: 320, unread: 177 } },
    { mailboxId: 'Drafts', name: 'Drafts', role: 'drafts' },
    { mailboxId: 'Sent', name: 'Sent', role: 'sent' },
    { mailboxId: 'Spam', name: 'Spam', role: 'spam' },
    { mailboxId: 'Trash', name: 'Trash', role: 'trash' },
  ];
  const labels = LABELS.map((name) => {
    const unread = STALE_UNREAD[name] ?? 0;
    return {
      mailboxId: labelId(name),
      name,
      role: 'other',
      // A stale label declares what the server holds; only `Receipts` also has rows in the retention
      // window, which is how a label can honestly show a badge over an empty page.
      ...(unread > 0 && name !== TAIL_WITH_MAIL ? { declared: { total: unread + 120, unread } } : {}),
    };
  });
  return [...roles, ...labels];
}

/** Account B: 6 folders, every id spelled differently from A's, and no ordinary labels by default. */
function mailboxesB() {
  return [
    // Declares 7 unread while the cache below holds 18: the divergence the merged header explains.
    { mailboxId: 'inbox', name: 'Inbox', role: 'inbox', declared: { total: 70, unread: 7 } },
    { mailboxId: 'archive', name: 'Archived', role: 'archive' },
    ...(noProviderDrafts ? [] : [{ mailboxId: 'marina/drafts', name: 'Drafts', role: 'drafts' }]),
    { mailboxId: B_SENT, name: 'Sent Mail', role: 'sent' },
    /* `Junk` and `Bin`, so this account's folder NAMES sort into a different ROLE order than A's: the
       server lists folders inbox first and then by name, so B reads inbox, archive, trash, drafts, spam,
       sent where A reads inbox, archive, drafts, sent, spam, trash. Two six row lists in two orders on one
       screen is what two real accounts do here, and a fixture that gave both the same order hid it. */
    { mailboxId: 'junk', name: 'Junk', role: 'spam', declared: { total: 60, unread: 37 } },
    { mailboxId: 'bin', name: 'Bin', role: 'trash', declared: { total: 3_200, unread: 2_609 } },
    ...(tailOne ? [{ mailboxId: 'marina/label/berths', name: 'Berths', role: 'other', declared: { total: 9, unread: 4 } }] : []),
  ];
}

const MAILBOXES = { [A]: mailboxesA(), [B]: mailboxesB() };

const SENDERS_A = [
  { name: 'Harbour Office', address: 'office@harbour.invalid' },
  { name: 'Ferry Desk', address: 'ferries@harbour.invalid' },
  { name: 'Tide Bulletin', address: 'tides@harbour.invalid' },
];
const SENDERS_B = [
  { name: 'Marina Desk', address: 'desk@marina.invalid' },
  { name: 'Berth Roster', address: 'berths@marina.invalid' },
];
const SUBJECTS_A = ['Timetable change', 'Dredging notice', 'Lamp repair', 'Gate code', 'Winter hours'];
const SUBJECTS_B = ['Berth swap', 'Fuel dock hours', 'Pontoon repair', 'Storm plan', 'Key collection'];

const MESSAGES = [];

/**
 * A page of messages in one folder, newest first, `unread` of them unread.
 *
 * Half-hour steps on A and 37-minute steps on B, deliberately coprime, so the merged list really
 * interleaves the two accounts instead of showing one account then the other.
 */
function fill(accountId, mailboxId, count, opts = {}) {
  const senders = accountId === A ? SENDERS_A : SENDERS_B;
  const subjects = accountId === A ? SUBJECTS_A : SUBJECTS_B;
  const step = accountId === A ? 30 * MINUTE : 37 * MINUTE;
  const start = NOW - (opts.startHours ?? 0) * HOUR;
  for (let index = 0; index < count; index += 1) {
    MESSAGES.push({
      accountId,
      mailboxId,
      messageId: `${opts.prefix ?? mailboxId}:1:${1000 - index}`,
      from: senders[index % senders.length],
      subject: `${subjects[index % subjects.length]} ${index + 1}`,
      sentAt: start - index * step,
      unread: index < (opts.unread ?? 0),
    });
  }
}

fill(A, 'INBOX', 60, { prefix: 'INBOX', unread: 0 });
// 17 unread here plus the unread half of the tie pair below is 18 cached unread rows, under a folder
// row that declares 7: both numbers are real, and the merged header is the only place a person can see
// them disagree.
fill(B, 'inbox', 70, { prefix: 'inbox', unread: 17, startHours: 0.2 });
fill(A, 'Sent', 8, { prefix: 'Sent' });
fill(B, B_SENT, 6, { prefix: 'marina-sent' });
fill(A, 'Drafts', 2, { prefix: 'Drafts' });
if (!noProviderDrafts) fill(B, 'marina/drafts', 1, { prefix: 'marina-drafts' });
fill(A, 'Archive', 4, { prefix: 'Archive', startHours: 40 });
fill(A, 'Spam', 3, { prefix: 'Spam', startHours: 50 });
fill(A, 'Trash', 2, { prefix: 'Trash', startHours: 60 });
fill(B, 'archive', 3, { prefix: 'marina-archive', startHours: 45 });
// The one collapsed-tail label with rows in the window: two of its six are unread, which matches the
// count its folder row declares, so a selection can start inside the tail and still be honest.
fill(A, labelId(TAIL_WITH_MAIL), 6, { prefix: 'receipts', unread: 2, startHours: 8 });

/**
 * The tie group: three messages at the SAME second across the two accounts, two of them sharing a
 * message id with different senders and subjects.
 *
 * A message's identity is (accountId, messageId), and this is the group that proves it: a client keyed
 * on the id alone drops one of these rows on the second page, marks the wrong one read, or paints one
 * account's row with the other's sender.
 */
const TIE_AT = NOW - 12 * HOUR;
MESSAGES.push(
  {
    // READ on A and unread on B on purpose: the read-flag path used to see the account's own row was
    // already read, decide there was nothing to do, and leave B's copy unread with no error at all.
    accountId: A, mailboxId: 'INBOX', messageId: 'shared-8042', sentAt: TIE_AT, unread: false,
    from: { name: 'Harbour Office', address: 'office@harbour.invalid' }, subject: 'Shared id, harbour copy',
  },
  {
    accountId: B, mailboxId: 'inbox', messageId: 'shared-8042', sentAt: TIE_AT, unread: true,
    from: { name: 'Marina Desk', address: 'desk@marina.invalid' }, subject: 'Shared id, marina copy',
  },
  {
    accountId: B, mailboxId: 'inbox', messageId: 'shared-8041', sentAt: TIE_AT, unread: false,
    from: { name: 'Berth Roster', address: 'berths@marina.invalid' }, subject: 'Same second, different id',
  },
);

/** Read state, as a server holds it: `markRead` moves this and every later poll agrees with it. */
const seen = new Set(MESSAGES.filter((one) => !one.unread).map((one) => `${one.accountId} ${one.messageId}`));

function key(accountId, messageId) {
  return `${accountId} ${messageId}`;
}

function bodyOf(one) {
  return `${one.subject}. Sent to the ${one.accountId === A ? 'harbour' : 'marina'} address.`;
}

/** The outside parties this person writes to, so a sent row has somebody to name. */
const OUTSIDE = [
  { name: 'Berth Office', address: 'berths@example.invalid' },
  { name: 'Ferry Desk', address: 'ferries@example.invalid' },
  { name: 'Chandlery', address: 'chandlery@example.invalid' },
];

/**
 * Who a message went TO.
 *
 * In a SENT or DRAFTS folder that is an outside party, which is the one fact such a list is scanned for:
 * with the account's own address here instead, a sent row could only ever print this person's own name
 * and no test could tell a recipient column from a sender column. Every third one goes to three people,
 * so a row can prove it prints the first plus a count of the rest rather than eleven names.
 */
function recipientsOf(one) {
  const role = (MAILBOXES[one.accountId] ?? []).find((box) => box.mailboxId === one.mailboxId)?.role;
  if (role !== 'sent' && role !== 'drafts') {
    return [{ address: one.accountId === A ? 'harbour@example.invalid' : 'marina@example.invalid' }];
  }
  const at = Number(one.messageId.split(':').pop() ?? 0) % OUTSIDE.length;
  return at === 0 ? OUTSIDE : [OUTSIDE[at]];
}

function envelopeOf(one) {
  const text = bodyOf(one);
  return {
    messageId: one.messageId,
    // The durable id carries the ACCOUNT, so the two copies of the shared message id are two messages
    // rather than one message cached twice.
    rfcMessageId: `<${one.messageId}.${one.accountId.replace(/[^a-z]/g, '')}@example.invalid>`,
    mailboxId: one.mailboxId,
    from: one.from,
    to: recipientsOf(one),
    subject: one.subject,
    snippet: `${one.subject}.`,
    sentAt: one.sentAt,
    sentAtHeader: new Date(one.sentAt).toUTCString(),
    flags: seen.has(key(one.accountId, one.messageId)) ? ['\\Seen'] : [],
    attachments: [],
    bodyBytes: Buffer.byteLength(text, 'utf8'),
  };
}

const ACCOUNTS = [
  {
    accountId: A,
    providerId: 'dense',
    displayName: 'Harbour mail',
    address: 'harbour@example.invalid',
    state: 'active',
  },
  {
    accountId: B,
    providerId: 'dense',
    displayName: 'Marina mail',
    address: 'marina@example.invalid',
    // Still counted by every smart row: its cached mail is real and still belongs in a merged list.
    state: authRequired ? 'auth-required' : 'active',
  },
];

function notFound(message) {
  const error = new Error(message);
  error.code = 'not-found';
  return error;
}

const spec = {
  id: 'dense',
  label: 'Dense Fixture Mail',
  capabilities: {
    search: false, watch: false, drafts: false, markRead: true, flags: false,
    threads: false, send: true, sendAsReply: true, bodies: 'text', attachments: 'none',
  },
  // NO fields: the base adopts both accounts as soon as this registers, so a spec starts with 70
  // folders and 160 messages already cached. `submit` is still required by the registry (a provider
  // with a form and one without take the same shape), and here it can only ever refuse: these two
  // accounts are ambient, so there is nothing for a human to type.
  setup: {
    fields: [],
    submit: async () => {
      const error = new Error('the dense fixture has no accounts to add: both are already here');
      error.code = 'invalid';
      throw error;
    },
  },
  async listAccounts() {
    return ACCOUNTS.map((one) => ({ ...one }));
  },
  async health(accountId) {
    return {
      state: accountId === B && authRequired ? 'auth-required' : 'ok',
      checkedAt: Date.now(),
      ...(accountId === B && authRequired ? { detail: 'the fixture parked this account' } : {}),
    };
  },
  async listMailboxes(accountId) {
    return (MAILBOXES[accountId] ?? []).map(({ declared, ...mailbox }) => {
      const held = MESSAGES.filter((one) => one.accountId === accountId && one.mailboxId === mailbox.mailboxId);
      return {
        ...mailbox,
        total: declared ? declared.total : held.length,
        unread: declared ? declared.unread : held.filter((one) => !seen.has(key(accountId, one.messageId))).length,
      };
    });
  },
  async poll(accountId, request) {
    const held = MESSAGES.filter((one) => one.accountId === accountId && one.mailboxId === request.mailbox);
    return { messages: held.map(envelopeOf), cursor: `${request.mailbox}:1:end`, more: false };
  },
  async getBody(accountId, messageId) {
    const one = MESSAGES.find((held) => held.accountId === accountId && held.messageId === messageId);
    if (!one) throw notFound(`no dense message ${messageId}`);
    const text = bodyOf(one);
    return { format: 'text', text, bytes: Buffer.byteLength(text, 'utf8') };
  },
  async markRead(accountId, messageId, read) {
    const one = MESSAGES.find((held) => held.accountId === accountId && held.messageId === messageId);
    if (!one) throw notFound(`no dense message ${messageId}`);
    if (read) seen.add(key(accountId, messageId));
    else seen.delete(key(accountId, messageId));
  },
  async send(accountId, mail, options) {
    const n = recordSend({
      accountId,
      to: mail.to,
      subject: mail.subject,
      bodyMarkdown: mail.bodyMarkdown,
      idempotencyKey: options?.idempotencyKey ?? '',
      at: Date.now(),
    });
    return { providerMessageId: `<dense-send-${n}@example.invalid>`, acceptedAt: Date.now() };
  },
  async removeAccount(accountId) {
    const at = ACCOUNTS.findIndex((one) => one.accountId === accountId);
    if (at >= 0) ACCOUNTS.splice(at, 1);
  },
};

export function activate(walnut) {
  const handle = walnut.services.require('mail:base').registerProvider(spec);
  return { dispose: () => handle.dispose() };
}
