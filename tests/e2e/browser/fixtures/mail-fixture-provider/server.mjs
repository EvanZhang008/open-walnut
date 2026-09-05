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
 *
 * Addresses are `*.invalid` (RFC 2606) and nothing here resolves.
 */

const HOUR = 60 * 60 * 1000;
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

const MAILBOXES = [
  { mailboxId: 'INBOX', name: 'Inbox', role: 'inbox' },
  { mailboxId: 'Archive', name: 'Archive', role: 'archive' },
];

/** Read state, as a server holds it. Seeded from the canned envelopes. */
const seen = new Set(MESSAGES.filter((one) => !one.unreadAtFirstSight).map((one) => one.messageId));

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
    send: false,
    sendAsReply: false,
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
    return MAILBOXES.map((mailbox) => {
      const held = MESSAGES.filter((one) => one.mailboxId === mailbox.mailboxId);
      return {
        ...mailbox,
        total: held.length,
        unread: held.filter((one) => !seen.has(one.messageId)).length,
      };
    });
  },
  async poll(_accountId, request) {
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
  async send() {
    const error = new Error('the fixture provider does not send');
    error.code = 'unsupported';
    throw error;
  },
  async removeAccount(accountId) {
    const at = accounts.findIndex((one) => one.accountId === accountId);
    if (at >= 0) accounts.splice(at, 1);
  },
};

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const handle = base.registerProvider(spec);
  // Returning the Disposable is how a provider hands ownership to the loader: turning this
  // plugin off detaches the provider live, with the base never knowing who registered it.
  return { dispose: () => handle.dispose() };
}
