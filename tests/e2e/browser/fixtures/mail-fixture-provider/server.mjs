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
    return [{ mailboxId: 'INBOX', name: 'Inbox', role: 'inbox', total: 0, unread: 0 }];
  },
  async poll(_accountId, request) {
    return { messages: [], cursor: `${request.mailbox}:1:end`, more: false };
  },
  async getBody() {
    throw notFound('the inbound fixture caches no bodies');
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

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const handles = [base.registerProvider(spec)];
  if (process.env.PW_MAIL_INBOUND_PROVIDER === '1') handles.push(base.registerProvider(inboundSpec));
  // Returning the Disposable is how a provider hands ownership to the loader: turning this
  // plugin off detaches the provider live, with the base never knowing who registered it.
  return { dispose: () => { for (const handle of handles) handle.dispose(); } };
}
