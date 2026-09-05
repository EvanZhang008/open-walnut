/**
 * The mail write path end to end: draft, approval letter, ledger, one send.
 *
 * The property every block here defends is EXACTLY ONCE. Not "usually once": a duplicate mail
 * cannot be recalled, and the human whose name is on it is the one who pays. So the fixture
 * provider counts every `send` call by idempotency key, and a test that ends with two calls for
 * one key has found a real bug however green the rest of the file is.
 *
 * The three gates being graded, each with its own block below:
 *
 * - The approval is minted by ONE conditional UPDATE naming the exact revision. An edit bumps
 *   the revision, so an approval for the text the human read can never approve text they did not.
 * - The ledger key `<draftId>:<revision>` is UNIQUE. A second answer, a retry, or two callers
 *   racing one revision produce one row, and the loser sends nothing.
 * - The attempt is claimed by a conditional UPDATE from `approved`. A reaper tick, a retry route
 *   and a re-entered handler all find the row already claimed.
 *
 * And the outcome vocabulary, which is the other half of the same promise: `failed` means the
 * transport refused the message before it took any of it, so a human may retry; `unknown` means
 * nobody can tell, so nothing here ever retries it and the human is pointed at the Sent folder.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-send-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { answerLetter, getLetter, listLetters } from '../../src/core/human-inbox/store.js';
import type { LetterRecord } from '../../src/core/human-inbox/types.js';
import { _resetPluginLetterQuotaForTesting } from '../../src/core/plugins/server-api.js';
import { mailDatabaseForTesting } from '../../src/integrations/mail/db.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import { mailSyncForTesting } from '../../src/integrations/mail/sync.js';
import { startServer, stopServer } from '../../src/web/server.js';

const FIXTURE_ID = 'mail-send-fixture';
const SENDER = 'sender:one';
const READONLY = 'sender:two';

interface SendCall {
  accountId: string;
  idempotencyKey: string;
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  text: string;
  html: string;
  inReplyTo?: string;
  references?: string[];
}

interface Fixture {
  /** How the next `send` behaves. Set per test. */
  sendMode: 'ok' | 'before-data' | 'after-data';
  /** Every send the base asked for, in order. THE assertion surface of this file. */
  sendCalls: SendCall[];
  /** Accounts whose per-account capabilities say `send: true`. */
  sendable: string[];
  accountCapabilityCalls: string[];
}

let server: HttpServer;
let port = 0;
const events: Array<{ name: string; data: Record<string, unknown> }> = [];

function marks(): Fixture {
  return (globalThis as unknown as { __mailSend: Fixture }).__mailSend;
}

function mailUrl(routePath: string): string {
  return `http://127.0.0.1:${port}/api/plugins/mail${routePath}`;
}

async function api<T>(method: string, routePath: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(mailUrl(routePath), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as T };
}

/** Answer a letter the way the console does: the real route, the real single-answer guard. */
async function answer(letterId: string, actionId: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/human-inbox/${letterId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId }),
  });
  return response.status;
}

async function rows<T extends Record<string, unknown>>(sql: string, params?: unknown): Promise<T[]> {
  const db = mailDatabaseForTesting();
  expect(db, 'the mail plugin must have an open database').not.toBeNull();
  return db!.all<T>(sql, params);
}

async function runSql(sql: string, params?: unknown): Promise<void> {
  const db = mailDatabaseForTesting();
  await db!.run(sql, params);
}

/** Letters this plugin sent, newest first. Read through the REAL inbox store. */
async function mailLetters(): Promise<LetterRecord[]> {
  const { letters } = await listLetters();
  return letters.filter((letter) => letter.sender.pluginId === 'mail');
}

async function letterBody(letterId: string): Promise<string> {
  const detail = await getLetter(letterId, { inlineMaxBytes: Number.POSITIVE_INFINITY });
  return detail?.body ?? '';
}

async function threadTexts(letterId: string): Promise<string[]> {
  const detail = await getLetter(letterId, { inlineMaxBytes: 0 });
  return (detail?.thread ?? []).map((entry) => entry.text ?? '');
}

interface DraftShape {
  draftId: string;
  revision: number;
  state: string;
  subject: string;
  bodyMarkdown: string;
  to: Array<{ name?: string; address: string }>;
  cc: Array<{ address: string }>;
  letterId?: string;
  inReplyTo?: string;
  references?: string[];
  error?: string;
}

interface SendShape {
  sendId: string;
  draftId: string;
  revision: number;
  idempotencyKey: string;
  approvalKind: string;
  approvalRef: string;
  state: string;
  providerMessageId?: string;
  error?: string;
}

async function newDraft(overrides: Record<string, unknown> = {}): Promise<DraftShape> {
  const created = await api<{ draft: DraftShape }>('POST', '/drafts', {
    accountId: SENDER,
    to: [{ name: 'Bob', address: 'bob@example.invalid' }],
    subject: 'Lunch on Thursday',
    bodyMarkdown: 'Does **noon** work for you?',
    ...overrides,
  });
  expect(created.status).toBe(201);
  return created.body.draft;
}

async function requestSend(draft: DraftShape, extra: Record<string, unknown> = {}): Promise<{
  status: number;
  body: { draft?: DraftShape; letterId?: string; error?: string; message?: string };
}> {
  return api('POST', `/drafts/${draft.draftId}/request-send`, { revision: draft.revision, ...extra });
}

async function draftOf(draftId: string): Promise<DraftShape> {
  const answered = await api<{ draft: DraftShape; sends: SendShape[] }>('GET', `/drafts/${draftId}`);
  expect(answered.status).toBe(200);
  return answered.body.draft;
}

async function sendsOf(draftId: string): Promise<SendShape[]> {
  const answered = await api<{ draft: DraftShape; sends: SendShape[] }>('GET', `/drafts/${draftId}`);
  return answered.body.sends;
}

function callsFor(draftId: string): SendCall[] {
  return marks().sendCalls.filter((call) => call.idempotencyKey.startsWith(`${draftId}:`));
}

async function writeConfig(mail: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(
    CONFIG_FILE,
    yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, plugins: { mail } }),
    'utf-8',
  );
}

/**
 * The fixture provider: a transport that never touches a network and reports its stage.
 *
 * `accountCapabilities` is the point of the two accounts. Reading needs a password and sending
 * needs SMTP settings, so two accounts behind one provider genuinely disagree about `send`, and
 * a static capability block would have to lie about one of them.
 */
async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Send Fixture',
    description: 'A mail provider that reports how far a send got',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const S = () => globalThis.__mailSend;

const MESSAGES = [
  {
    uid: 1,
    subject: 'Kickoff',
    rfcMessageId: '<original@example.invalid>',
    references: ['<root@example.invalid>'],
  },
  {
    uid: 2,
    subject: 'Re: Kickoff',
    rfcMessageId: '<second@example.invalid>',
    references: ['<root@example.invalid>', '<original@example.invalid>'],
  },
];

function envelopeOf(message) {
  return {
    messageId: 'INBOX:900:' + message.uid,
    rfcMessageId: message.rfcMessageId,
    mailboxId: 'INBOX',
    from: { name: 'Bob', address: 'bob@example.invalid' },
    to: [{ address: 'alice@example.invalid' }],
    subject: message.subject,
    sentAt: Date.UTC(2026, 0, 10 + message.uid, 9, 0, 0),
    flags: [],
    attachments: [],
    references: message.references,
    inReplyTo: message.references[message.references.length - 1],
  };
}

const CAPABILITIES = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: true, sendAsReply: true, bodies: 'text', attachments: 'none',
};

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const handle = base.registerProvider({
    id: 'sender',
    label: 'Sender',
    capabilities: CAPABILITIES,
    accountCapabilities: (accountId) => {
      const state = S();
      state.accountCapabilityCalls.push(accountId);
      return { ...CAPABILITIES, send: state.sendable.includes(accountId), sendAsReply: state.sendable.includes(accountId) };
    },
    setup: {
      fields: [{ name: 'which', label: 'Which', kind: 'text' }],
      submit: async (values) => ({
        accountId: 'sender:' + values.which,
        providerId: 'sender',
        displayName: values.which === 'one' ? 'Sending account' : 'Read only account',
        address: values.which === 'one' ? 'alice@example.invalid' : 'reader@example.invalid',
        state: 'active',
      }),
    },
    listAccounts: async () => [
      { accountId: '${SENDER}', providerId: 'sender', displayName: 'Sending account', address: 'alice@example.invalid', state: 'active' },
      { accountId: '${READONLY}', providerId: 'sender', displayName: 'Read only account', address: 'reader@example.invalid', state: 'active' },
    ],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async (accountId) => [
      { mailboxId: 'INBOX', name: 'INBOX', role: 'inbox', unread: 0, total: accountId === '${SENDER}' ? MESSAGES.length : 0 },
      { mailboxId: 'Sent', name: 'Sent', role: 'sent', unread: 0, total: 0 },
    ],
    poll: async (accountId, request) => {
      const mine = accountId === '${SENDER}' && request.mailbox === 'INBOX';
      return {
        messages: mine ? MESSAGES.map(envelopeOf) : [],
        cursor: '900:' + (mine ? MESSAGES.length : 0),
        more: false,
      };
    },
    getBody: async () => ({ format: 'text', text: 'The original message.', bytes: 21 }),
    send: async (accountId, mail, options) => {
      const state = S();
      state.sendCalls.push({
        accountId,
        idempotencyKey: options.idempotencyKey,
        subject: mail.subject,
        to: (mail.to ?? []).map((one) => one.address),
        cc: (mail.cc ?? []).map((one) => one.address),
        bcc: (mail.bcc ?? []).map((one) => one.address),
        text: mail.bodyMarkdown ?? '',
        html: mail.bodyHtml ?? '',
        inReplyTo: mail.inReplyTo,
        references: mail.references,
      });
      if (state.sendMode === 'before-data') {
        const error = new Error('the server rejected every recipient');
        error.code = 'invalid';
        error.stage = 'before-data';
        throw error;
      }
      if (state.sendMode === 'after-data') {
        const error = new Error('the connection dropped while the message was being written');
        error.code = 'unreachable';
        error.stage = 'after-data';
        throw error;
      }
      return { providerMessageId: '<sent-' + state.sendCalls.length + '@example.invalid>', acceptedAt: Date.now() };
    },
  });
  return { dispose: () => handle.dispose() };
}
`);
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  (globalThis as unknown as { __mailSend: Fixture }).__mailSend = {
    sendMode: 'ok',
    sendCalls: [],
    sendable: [SENDER],
    accountCapabilityCalls: [],
  };
  await writeFixtureProvider();
  bus.subscribe('mail-send-observer', (event) => {
    if (event.name.startsWith('plugin:mail:')) {
      events.push({ name: event.name.slice('plugin:mail:'.length), data: event.data as Record<string, unknown> });
    }
  }, { global: true, interest: ['plugin:mail:'] });
  // A long poll interval: every tick in this file is driven explicitly, so a background timer
  // cannot land a reaper pass between an action and its assertion. `retention_days` is wide open
  // because the retention sweep runs at the end of every tick and would otherwise delete the
  // fixture's fixed-date messages for being older than the default 180 days.
  await writeConfig({ poll_interval_seconds: 3600, retention_days: 3650 });
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  for (const which of ['one', 'two']) {
    const created = await api<{ account: { accountId: string } }>('POST', '/accounts', {
      providerId: 'sender',
      values: { which },
    });
    expect(created.status, `account ${which}`).toBe(201);
  }
  // The reply tests need the original message in the cache, which is what the account setup's
  // kicked poll puts there. A hand-rolled wait because `expect.poll` only works inside a test.
  const until = Date.now() + 30_000;
  while (Date.now() < until && (await rows('SELECT rowid FROM messages')).length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(await rows('SELECT rowid FROM messages')).toHaveLength(2);
}, 180_000);

beforeEach(() => {
  marks().sendCalls.length = 0;
  marks().sendMode = 'ok';
  marks().sendable = [SENDER];
  events.length = 0;
  // The host caps a plugin at 30 letters a minute, and this file legitimately sends more than
  // that across its run. Clearing the window keeps the cap's own test the only place it applies.
  _resetPluginLetterQuotaForTesting();
});

afterAll(async () => {
  bus.unsubscribe('mail-send-observer');
  await stopServer();
  delete (globalThis as unknown as { __mailSend?: Fixture }).__mailSend;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

function eventsOf(name: string): Array<Record<string, unknown>> {
  return events.filter((event) => event.name === name).map((event) => event.data);
}

describe('drafts are versioned rows', () => {
  it('creates, reads, lists and edits a draft, bumping the revision on every edit', async () => {
    const draft = await newDraft({ cc: [{ address: 'carol@example.invalid' }] });
    expect(draft).toMatchObject({
      accountId: SENDER,
      subject: 'Lunch on Thursday',
      bodyMarkdown: 'Does **noon** work for you?',
      revision: 1,
      state: 'composing',
      origin: 'console',
    });
    expect(draft.to).toEqual([{ name: 'Bob', address: 'bob@example.invalid' }]);
    expect(draft.cc).toEqual([{ address: 'carol@example.invalid' }]);

    const listed = await api<{ drafts: DraftShape[] }>('GET', `/drafts?account=${encodeURIComponent(SENDER)}&state=composing`);
    expect(listed.body.drafts.map((one) => one.draftId)).toContain(draft.draftId);

    // A PATCH that names one field keeps every other stored value: a partial edit must not blank
    // a recipient list by omission.
    const patched = await api<{ draft: DraftShape }>('PATCH', `/drafts/${draft.draftId}`, {
      bodyMarkdown: 'Does noon work? I can also do one.',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.draft.revision).toBe(2);
    expect(patched.body.draft.subject).toBe('Lunch on Thursday');
    expect(patched.body.draft.cc).toEqual([{ address: 'carol@example.invalid' }]);
    expect(patched.body.draft.state).toBe('composing');
    expect(eventsOf('draft-changed')).toEqual(expect.arrayContaining([
      { draftId: draft.draftId, state: 'composing', revision: 2 },
    ]));
  });

  it('refuses an address that is not one, and a header break hidden in a display name', async () => {
    const bad = await api<{ error: string }>('POST', '/drafts', {
      accountId: SENDER, to: [{ address: 'not-an-address' }], subject: 'x', bodyMarkdown: 'x',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid');

    const injected = await api<{ error: string }>('POST', '/drafts', {
      accountId: SENDER,
      to: [{ name: 'Bob\r\nBcc: sneaky@example.invalid', address: 'bob@example.invalid' }],
      subject: 'x',
      bodyMarkdown: 'x',
    });
    expect(injected.status).toBe(400);
  });

  it('copies the reply headers from the cached message and prefixes Re: exactly once', async () => {
    const reply = await newDraft({
      subject: '',
      inReplyTo: { accountId: SENDER, messageId: 'INBOX:900:1' },
    });
    expect(reply.subject).toBe('Re: Kickoff');
    expect(reply.inReplyTo).toBe('<original@example.invalid>');
    // The chain, plus the message being answered, in order: taken from the CACHE, never from the
    // request, so a caller cannot aim a reply into a thread it never read.
    expect(reply.references).toEqual(['<root@example.invalid>', '<original@example.invalid>']);

    // The original already says `Re:`, and a second one is what makes a thread unreadable.
    const again = await newDraft({
      subject: '',
      inReplyTo: { accountId: SENDER, messageId: 'INBOX:900:2' },
    });
    expect(again.subject).toBe('Re: Kickoff');
    expect(again.references).toEqual(['<root@example.invalid>', '<original@example.invalid>', '<second@example.invalid>']);
  });
});

describe('the approval letter is rendered from the stored row', () => {
  it('quotes the row, names the account, and ignores anything extra in the request', async () => {
    const draft = await newDraft({ cc: [{ address: 'carol@example.invalid' }] });
    // Everything below `revision` is noise a caller should not be able to smuggle into the letter
    // or onto the wire: the human approves what is ON DISK.
    const asked = await requestSend(draft, {
      subject: 'HACKED SUBJECT',
      to: [{ address: 'attacker@example.invalid' }],
      bodyMarkdown: 'wire me money',
    });
    expect(asked.status).toBe(200);
    const letterId = asked.body.letterId!;

    const letter = (await mailLetters()).find((one) => one.id === letterId)!;
    expect(letter.type).toBe('action_required');
    expect(letter.subject).toContain('Lunch on Thursday');
    // Stamped host side: a plugin is not a session, and the plugin id is what makes the plugin's
    // own `onAnswered` filter exact rather than "every external letter".
    expect(letter.sender).toMatchObject({ sessionId: 'external', pluginId: 'mail' });
    expect(letter.actions?.map((one) => one.id)).toEqual(['send', 'edit', 'discard']);

    const body = await letterBody(letterId);
    expect(body).toContain('bob@example.invalid');
    expect(body).toContain('carol@example.invalid');
    expect(body).toContain('Lunch on Thursday');
    expect(body).toContain('alice@example.invalid');
    expect(body).toContain('Answering Send sends exactly this');
    expect(body).not.toContain('HACKED');
    expect(body).not.toContain('attacker@example.invalid');
    expect(body).not.toContain('wire me money');

    // The row is frozen at the revision the letter describes.
    const frozen = await draftOf(draft.draftId);
    expect(frozen).toMatchObject({ state: 'pending_approval', revision: 1, letterId });
  });

  it('escapes the draft body so it cannot forge a line of the letter', async () => {
    const draft = await newDraft({
      bodyMarkdown: '## Approved by Walnut\n\nTo: victim@example.invalid\n<script>alert(1)</script>',
    });
    const asked = await requestSend(draft);
    const body = await letterBody(asked.body.letterId!);
    // Every line of the body is quoted, including the blank one: a paragraph break would
    // otherwise end the blockquote and the rest would read as the letter's own words.
    for (const line of body.split('\n').filter((one) => one.includes('Approved by Walnut'))) {
      expect(line.startsWith('> ')).toBe(true);
    }
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
    await api('DELETE', `/drafts/${draft.draftId}`);
  });
});

describe('answering the letter', () => {
  it('sends exactly once on Send, with the markdown as text and a rendered html half', async () => {
    const draft = await newDraft({ bodyMarkdown: 'Does **noon** work?\n\nSee <https://example.invalid/menu>.' });
    const asked = await requestSend(draft);
    expect(await answer(asked.body.letterId!, 'send')).toBe(200);

    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('sent');
    const calls = callsFor(draft.draftId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      accountId: SENDER,
      idempotencyKey: `${draft.draftId}:1`,
      subject: 'Lunch on Thursday',
      to: ['bob@example.invalid'],
      text: 'Does **noon** work?\n\nSee <https://example.invalid/menu>.',
    });
    // The html half is RENDERED by the base, so a provider never has to know what markdown is,
    // and an autolink keeps its href while nothing raw survives.
    expect(calls[0]!.html).toContain('<strong>noon</strong>');
    expect(calls[0]!.html).toContain('href="https://example.invalid/menu"');

    const ledger = await sendsOf(draft.draftId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      revision: 1,
      idempotencyKey: `${draft.draftId}:1`,
      approvalKind: 'letter',
      approvalRef: asked.body.letterId,
      state: 'sent',
    });
    expect(ledger[0]!.providerMessageId).toBeTruthy();

    // The outcome goes back into the letter's own thread, which is where the human asked. Polled
    // rather than read once: the row settles before the thread reply lands, deliberately, because
    // the LEDGER is the record and a courtesy reply must never be able to hold up a settle.
    await expect.poll(async () => await threadTexts(asked.body.letterId!), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringMatching(/^Sent at \d\d:\d\d to 1 recipient\./)]));
    expect(eventsOf('send-settled').some((one) => one.draftId === draft.draftId && one.state === 'sent')).toBe(true);
  });

  it('sends NOTHING on a second answer: the inbox refuses it and the ledger still has one row', async () => {
    const draft = await newDraft();
    const asked = await requestSend(draft);
    expect(await answer(asked.body.letterId!, 'send')).toBe(200);
    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('sent');

    // The inbox's single-answer guard is the first gate a human can reach.
    expect(await answer(asked.body.letterId!, 'send')).toBe(409);
    // And the ledger is the gate nothing can reach twice, whatever got past the first.
    expect(callsFor(draft.draftId)).toHaveLength(1);
    expect(await sendsOf(draft.draftId)).toHaveLength(1);
    expect(await rows('SELECT send_id FROM sends WHERE draft_id = ?', [draft.draftId])).toHaveLength(1);
  });

  it('puts the draft back on Edit and throws it away on Discard, sending nothing either way', async () => {
    const edited = await newDraft();
    const editLetter = (await requestSend(edited)).body.letterId!;
    expect(await answer(editLetter, 'edit')).toBe(200);
    await expect.poll(async () => (await draftOf(edited.draftId)).state, { timeout: 15_000 }).toBe('composing');
    // An `edit` answer is not an edit: the revision stays where it was, so the human can ask
    // again for the same text without the ledger key moving under them.
    expect((await draftOf(edited.draftId)).revision).toBe(1);
    await expect.poll(async () => await threadTexts(editLetter), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining('Edit it in the Mail console')]));

    const thrown = await newDraft();
    const discardLetter = (await requestSend(thrown)).body.letterId!;
    expect(await answer(discardLetter, 'discard')).toBe(200);
    await expect.poll(async () => (await draftOf(thrown.draftId)).state, { timeout: 15_000 }).toBe('discarded');
    await expect.poll(async () => await threadTexts(discardLetter), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining('Discarded, nothing was sent')]));

    expect(callsFor(edited.draftId)).toEqual([]);
    expect(callsFor(thrown.draftId)).toEqual([]);
  });
});

describe('an edit invalidates the approval it was asked for', () => {
  it('withdraws the stale letter, issues a fresh one, and only the fresh one can send', async () => {
    const draft = await newDraft();
    const first = await requestSend(draft);
    const staleLetter = first.body.letterId!;

    const patched = await api<{ draft: DraftShape; letterId?: string }>('PATCH', `/drafts/${draft.draftId}`, {
      bodyMarkdown: 'Actually, can we make it one?',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.draft.revision).toBe(2);
    const freshLetter = patched.body.letterId!;
    expect(freshLetter).not.toBe(staleLetter);

    // The old letter is ANSWERED, by its sender, with the reason in its thread. A live Send
    // button pointing at a revision the ledger can no longer approve reads to the human as
    // "I tapped Send and nothing happened".
    const stale = (await mailLetters()).find((one) => one.id === staleLetter)!;
    expect(stale.answered?.actionId).toBe('withdrawn');
    expect(stale.answered?.freeText).toContain('a fresh letter follows');
    expect(await answer(staleLetter, 'send')).toBe(409);

    // The fresh letter describes the NEW text and sends once.
    expect(await letterBody(freshLetter)).toContain('make it one');
    expect(await answer(freshLetter, 'send')).toBe(200);
    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('sent');
    const calls = callsFor(draft.draftId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.idempotencyKey).toBe(`${draft.draftId}:2`);
    expect(calls[0]!.text).toBe('Actually, can we make it one?');
  });

  it('mints nothing when an answer arrives for a letter the draft no longer points at', async () => {
    const draft = await newDraft();
    const first = await requestSend(draft);
    const staleLetter = first.body.letterId!;
    await api('PATCH', `/drafts/${draft.draftId}`, { subject: 'Lunch on Friday' });

    // The inbox would refuse this answer (the letter was withdrawn), so the event is delivered
    // straight to the bus: this grades the LEDGER's own gate rather than the inbox's, and that
    // gate is the one that has to hold if anything ever answers a letter another way.
    bus.emit('human-inbox:answered', {
      letterId: staleLetter,
      actionId: 'send',
      label: 'Send',
      answeredAt: Date.now(),
      source: 'web',
      pluginId: 'mail',
    }, ['web-ui'], { source: 'mail-send-test' });

    await expect.poll(async () => await threadTexts(staleLetter), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining('no longer the one Walnut is waiting on')]));
    // And it does NOT claim a send happened. A human who reads "already sent" about a message that
    // was never sent stops looking for it, and no `sends` row exists here at all.
    expect((await threadTexts(staleLetter)).join(' ')).not.toContain('already under way');
    expect(callsFor(draft.draftId)).toEqual([]);
    expect(await sendsOf(draft.draftId)).toEqual([]);
    expect((await draftOf(draft.draftId)).state).toBe('pending_approval');
  });
});

describe('the console can send without a letter', () => {
  it('sends once for the right revision and withdraws the outstanding letter', async () => {
    const draft = await newDraft();
    const asked = await requestSend(draft);
    const letterId = asked.body.letterId!;

    const sent = await api<{ send: SendShape; draft: DraftShape }>(
      'POST', `/drafts/${draft.draftId}/send`, { revision: 1 },
    );
    expect(sent.status).toBe(200);
    expect(sent.body.send).toMatchObject({
      state: 'sent', approvalKind: 'console', revision: 1, idempotencyKey: `${draft.draftId}:1`,
    });
    expect(callsFor(draft.draftId)).toHaveLength(1);

    // The letter asked a question that has been answered another way, so it is retired rather
    // than left live: two paths to one send is exactly what the ledger key exists to stop, and a
    // live button the human can still tap is a worse experience than a withdrawn one.
    await expect.poll(
      async () => (await mailLetters()).find((one) => one.id === letterId)?.answered?.actionId,
      { timeout: 15_000 },
    ).toBe('withdrawn');
    expect(await answer(letterId, 'send')).toBe(409);
    expect(callsFor(draft.draftId)).toHaveLength(1);
  });

  it('refuses a revision the caller was not looking at', async () => {
    const draft = await newDraft();
    await api('PATCH', `/drafts/${draft.draftId}`, { subject: 'Moved to Friday' });
    const wrong = await api<{ error: string; message: string }>(
      'POST', `/drafts/${draft.draftId}/send`, { revision: 1 },
    );
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe('stale');
    expect(callsFor(draft.draftId)).toEqual([]);
  });
});

describe('a send that failed before the transport took any data', () => {
  it('is `failed`, says so, and a retry asks again for a new revision', async () => {
    marks().sendMode = 'before-data';
    const draft = await newDraft();
    const asked = await requestSend(draft);
    expect(await answer(asked.body.letterId!, 'send')).toBe(200);

    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('failed');
    const failedRow = (await sendsOf(draft.draftId))[0]!;
    expect(failedRow.state).toBe('failed');
    expect(failedRow.error).toContain('rejected every recipient');
    await expect.poll(async () => await threadTexts(asked.body.letterId!), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining('You can retry from the Mail console')]));

    // The retry is a whole fresh round: a new revision, so a new ledger key, and the human is
    // asked again. It never re-attempts the row it was handed.
    marks().sendMode = 'ok';
    const retried = await api<{ draft: DraftShape; letterId: string }>(
      'POST', `/sends/${failedRow.sendId}/retry`,
    );
    expect(retried.status).toBe(200);
    expect(retried.body.draft.revision).toBe(2);
    expect(await answer(retried.body.letterId, 'send')).toBe(200);

    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('sent');
    const calls = callsFor(draft.draftId);
    expect(calls.map((one) => one.idempotencyKey)).toEqual([`${draft.draftId}:1`, `${draft.draftId}:2`]);
    const ledger = await sendsOf(draft.draftId);
    expect(ledger.map((one) => one.state).sort()).toEqual(['failed', 'sent']);
  });
});

describe('a send whose outcome nobody can know', () => {
  it('is `unknown`, is never retried, and never reaches the transport a second time', async () => {
    marks().sendMode = 'after-data';
    const draft = await newDraft();
    const asked = await requestSend(draft);
    expect(await answer(asked.body.letterId!, 'send')).toBe(200);

    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('unknown');
    const row = (await sendsOf(draft.draftId))[0]!;
    expect(row.state).toBe('unknown');
    await expect.poll(async () => await threadTexts(asked.body.letterId!), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining('Check the Sent folder')]));

    // SMTP has no dedupe, so the only honest answer to "retry?" is no.
    marks().sendMode = 'ok';
    const refused = await api<{ error: string; message: string }>('POST', `/sends/${row.sendId}/retry`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('invalid');
    expect(refused.body.message).toContain('Sent folder');

    // Nor does a tick, which is the other thing that touches an unsettled row.
    await mailSyncForTesting()!.runTick({});
    expect(callsFor(draft.draftId)).toHaveLength(1);
    expect((await sendsOf(draft.draftId)).map((one) => one.state)).toEqual(['unknown']);
  });

  it('reaps a row that has been `sending` since before the process died', async () => {
    const draft = await newDraft();
    const asked = await requestSend(draft);
    const letterId = asked.body.letterId!;
    // The state a crash leaves behind, reconstructed exactly: a claimed attempt whose process
    // never came back. Written as rows because that is the only way to be mid-attempt without a
    // transport that hangs, and a hanging transport in a test is a flake waiting to happen.
    const sendId = 'sn-reaper-fixture';
    const attemptedAt = Date.now() - 6 * 60_000;
    await runSql(
      'INSERT INTO sends (send_id, draft_id, account_id, idempotency_key, approval_kind, approval_ref,'
      + ' state, revision, created_at, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [sendId, draft.draftId, SENDER, `${draft.draftId}:1`, 'letter', letterId, 'sending', 1, attemptedAt, attemptedAt],
    );
    await runSql('UPDATE drafts SET state = \'sending\' WHERE draft_id = ?', [draft.draftId]);

    await mailSyncForTesting()!.runTick({});

    const reaped = (await rows<{ state: string; settled_at: number | null }>(
      'SELECT state, settled_at FROM sends WHERE send_id = ?', [sendId],
    ))[0]!;
    expect(reaped.state).toBe('unknown');
    expect(reaped.settled_at).toBeGreaterThan(0);
    expect((await draftOf(draft.draftId)).state).toBe('unknown');
    expect(await threadTexts(letterId)).toEqual(expect.arrayContaining([
      expect.stringContaining('Walnut stopped while this message was being sent'),
    ]));
    // The reaper settles a row; it never sends one.
    expect(callsFor(draft.draftId)).toEqual([]);

    // And a second tick says nothing more: the row is settled, so it is no longer stuck.
    const before = (await threadTexts(letterId)).length;
    await mailSyncForTesting()!.runTick({});
    expect(await threadTexts(letterId)).toHaveLength(before);
  });
});

/**
 * Recovery: every way a send can be left half-done, and what puts it right.
 *
 * These are not hypotheticals. Each one was reachable in the first cut of this slice, and the shape
 * of the bug was the same every time: the ledger key `<draftId>:<revision>` is SPENT once a send for
 * it has run, so anything that freezes a draft at a spent revision produces a draft that can never
 * be approved again, sends nothing, and reports the PREVIOUS attempt's outcome as if it were this
 * request's answer. The other half is the two-statement window between minting an approval and
 * writing the ledger row: no transaction spans it, so a process that dies inside it leaves a draft
 * frozen with nobody left to finish it.
 *
 * The invariant every test here shares with the rest of the file: one send call per key, ever.
 */
describe('recovering a draft nobody could finish', () => {
  it('asks again at a NEW revision after a failed send, rather than wedging on the spent key', async () => {
    marks().sendMode = 'before-data';
    const draft = await newDraft();
    const first = await requestSend(draft);
    expect(await answer(first.body.letterId!, 'send')).toBe(200);
    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('failed');

    // The console is still holding revision 1, which is what the draft really is: the failed attempt
    // did not bump it. Asked again at that revision, the request used to succeed, freeze, approve,
    // and then hand back the OLD failed row, leaving the draft parked in `approved` for good with
    // the console showing a stale failure as if it were fresh.
    marks().sendMode = 'ok';
    const again = await requestSend(draft);
    expect(again.status).toBe(200);
    // The new revision is in the answer, because the caller has to be able to follow it.
    expect(again.body.draft!.revision).toBe(2);
    expect(again.body.draft!.state).toBe('pending_approval');

    expect(await answer(again.body.letterId!, 'send')).toBe(200);
    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('sent');
    expect(callsFor(draft.draftId).map((one) => one.idempotencyKey))
      .toEqual([`${draft.draftId}:1`, `${draft.draftId}:2`]);
    expect((await sendsOf(draft.draftId)).map((one) => one.idempotencyKey).sort())
      .toEqual([`${draft.draftId}:1`, `${draft.draftId}:2`]);
  });

  it('sends from the console after a failed send, once, at a new revision', async () => {
    marks().sendMode = 'before-data';
    const draft = await newDraft();
    const asked = await requestSend(draft);
    expect(await answer(asked.body.letterId!, 'send')).toBe(200);
    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('failed');

    // The console's own Send had the same hole, and it answered 200 while sending nothing.
    marks().sendMode = 'ok';
    const sent = await api<{ send: SendShape; draft: DraftShape }>(
      'POST', `/drafts/${draft.draftId}/send`, { revision: 1 },
    );
    expect(sent.status).toBe(200);
    expect(sent.body.send).toMatchObject({
      state: 'sent', revision: 2, idempotencyKey: `${draft.draftId}:2`, approvalKind: 'console',
    });
    expect(callsFor(draft.draftId).map((one) => one.idempotencyKey))
      .toEqual([`${draft.draftId}:1`, `${draft.draftId}:2`]);
  });

  it('refuses a send whose ledger key is already spent, and never leaves the draft frozen', async () => {
    const draft = await newDraft();
    // A spent key under an editable draft: the belt to the revision bump's braces. However it came
    // about, what must not happen is a 200 carrying somebody else's outcome.
    await runSql(
      'INSERT INTO sends (send_id, draft_id, account_id, idempotency_key, approval_kind, approval_ref,'
      + ' state, revision, created_at, attempted_at, settled_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        'sn-spent-fixture', draft.draftId, SENDER, `${draft.draftId}:1`, 'console', 'console',
        'failed', 1, Date.now(), Date.now(), Date.now(), 'the server rejected every recipient',
      ],
    );

    const refused = await api<{ error: string; message: string }>(
      'POST', `/drafts/${draft.draftId}/send`, { revision: 1 },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('stale');
    expect(refused.body.message).toContain('already sent once');
    // Nothing went out, and the draft is back in a state a human can act on rather than stuck in
    // `approved` where nothing but a DELETE could reach it.
    expect(callsFor(draft.draftId)).toEqual([]);
    const after = await draftOf(draft.draftId);
    expect(after.state).toBe('failed');
    expect(after.letterId).toBeUndefined();

    await runSql('DELETE FROM sends WHERE send_id = ?', ['sn-spent-fixture']);
  });

  it('resumes a send whose ledger row was never written, when the letter is answered', async () => {
    const draft = await newDraft();
    const asked = await requestSend(draft);
    const letterId = asked.body.letterId!;
    // The crash, reconstructed exactly: `approveDraft` committed and `insertSend` never ran. The
    // approval is REAL and this letter is the one that granted it, so the human's answer picks up
    // where the dead process left off. The ledger's UNIQUE key is still the gate.
    await runSql(
      "UPDATE drafts SET state = 'approved', approved_at = ? WHERE draft_id = ?",
      [Date.now(), draft.draftId],
    );

    expect(await answer(letterId, 'send')).toBe(200);
    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('sent');
    const calls = callsFor(draft.draftId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.idempotencyKey).toBe(`${draft.draftId}:1`);
    expect(await sendsOf(draft.draftId)).toMatchObject([
      { revision: 1, approvalKind: 'letter', approvalRef: letterId, state: 'sent' },
    ]);
  });

  it('unfreezes an `approved` draft with no ledger row, and only after the grace window', async () => {
    const draft = await newDraft();
    const asked = await requestSend(draft);
    const letterId = asked.body.letterId!;
    await runSql(
      "UPDATE drafts SET state = 'approved', approved_at = ? WHERE draft_id = ?",
      [Date.now(), draft.draftId],
    );

    // Freshly approved: a send may be running RIGHT NOW in the two-statement window, and a
    // reconciler that unfroze it would race a live attempt. The grace window is what makes this
    // sweep safe to run every tick.
    await mailSyncForTesting()!.runTick({});
    expect((await draftOf(draft.draftId)).state).toBe('approved');

    // Past the window, nobody is coming back for it.
    await runSql('UPDATE drafts SET updated_at = ? WHERE draft_id = ?', [Date.now() - 3 * 60_000, draft.draftId]);
    await mailSyncForTesting()!.runTick({});

    const after = await draftOf(draft.draftId);
    expect(after.state).toBe('composing');
    expect(after.revision).toBe(1);
    expect(after.letterId).toBeUndefined();
    // The letter is retired rather than left live, and the thread says what is true: nothing was
    // sent. Claiming otherwise is the one answer a human cannot recover from, because they stop
    // looking for the message.
    await expect.poll(
      async () => (await mailLetters()).find((one) => one.id === letterId)?.answered?.actionId,
      { timeout: 15_000 },
    ).toBe('withdrawn');
    expect((await threadTexts(letterId)).join(' ')).toContain('Nothing was sent');
    expect(callsFor(draft.draftId)).toEqual([]);
  });

  it('resumes a letter that was answered while nothing was listening, and leaves an unanswered one alone', async () => {
    const draft = await newDraft();
    const asked = await requestSend(draft);
    // `bus.emit` does not await its subscribers, so an answer can be RECORDED with the handler never
    // running: the process goes away between the write and the dispatch. Written straight to the
    // inbox store here, which is exactly that: the letter says Send, and nothing minted anything.
    await answerLetter(asked.body.letterId!, { actionId: 'send' });
    expect(await sendsOf(draft.draftId)).toEqual([]);
    await runSql('UPDATE drafts SET updated_at = ? WHERE draft_id = ?', [Date.now() - 3 * 60_000, draft.draftId]);

    await mailSyncForTesting()!.runTick({});
    await expect.poll(async () => (await draftOf(draft.draftId)).state, { timeout: 15_000 }).toBe('sent');
    expect(callsFor(draft.draftId).map((one) => one.idempotencyKey)).toEqual([`${draft.draftId}:1`]);

    // The other half, and the reason this sweep cannot simply unfreeze everything old: an
    // UNANSWERED letter is a human taking their time. A draft waiting two days for an answer must
    // come out of the tick untouched.
    const waiting = await newDraft({ subject: 'Still waiting' });
    const waitingLetter = (await requestSend(waiting)).body.letterId!;
    await runSql('UPDATE drafts SET updated_at = ? WHERE draft_id = ?', [Date.now() - 2 * 24 * 3600_000, waiting.draftId]);
    await mailSyncForTesting()!.runTick({});
    expect(await draftOf(waiting.draftId)).toMatchObject({ state: 'pending_approval', letterId: waitingLetter });
    expect(callsFor(waiting.draftId)).toEqual([]);
    await api('DELETE', `/drafts/${waiting.draftId}`);
  });
});

describe('the reaper cannot undo an outcome, and cannot eat a tick', () => {
  it('leaves a row that settled under it exactly as it is', async () => {
    const write = new MailStore(mailDatabaseForTesting()!).write;
    const draft = await newDraft();
    const sendId = 'sn-conditional-settle';
    await runSql(
      'INSERT INTO sends (send_id, draft_id, account_id, idempotency_key, approval_kind, approval_ref,'
      + ' state, revision, created_at, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [sendId, draft.draftId, SENDER, `${draft.draftId}:1`, 'console', 'console', 'sending', 1, Date.now(), Date.now()],
    );

    // The attempt finishing wins, because it is the one holding the row.
    expect(await write.settleSend(sendId, 'sent', { providerMessageId: '<x@example.invalid>', now: Date.now() })).toBe(1);
    // A reaper that was starved for five minutes and still believes this row is in flight changes
    // NOTHING. Unconditional, it would overwrite a delivered message with `unknown` and send the
    // human off to search the Sent folder for a mail that arrived fine.
    expect(await write.settleSend(sendId, 'unknown', { error: 'the reaper thought this died', now: Date.now() })).toBe(0);
    const row = (await rows<{ state: string; error: string | null }>(
      'SELECT state, error FROM sends WHERE send_id = ?', [sendId],
    ))[0]!;
    expect(row).toMatchObject({ state: 'sent', error: null });

    await runSql('DELETE FROM sends WHERE send_id = ?', [sendId]);
  });

  it('settles at most a batch per tick, so a backlog cannot eat the poll and the sweep', async () => {
    const draft = await newDraft();
    const attemptedAt = Date.now() - 6 * 60_000;
    // Eleven rows the process died holding. One tick also has to poll every account and run the
    // retention sweep inside 20 seconds, and each of these costs three database round trips plus a
    // letter reply under the inbox's write lock.
    for (let index = 0; index < 11; index += 1) {
      await runSql(
        'INSERT INTO sends (send_id, draft_id, account_id, idempotency_key, approval_kind, approval_ref,'
        + ' state, revision, created_at, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          `sn-batch-${index}`, draft.draftId, SENDER, `${draft.draftId}:${90 + index}`, 'console',
          'console', 'sending', 90 + index, attemptedAt, attemptedAt + index,
        ],
      );
    }

    const stillSending = async () => (await rows(
      "SELECT send_id FROM sends WHERE send_id LIKE 'sn-batch-%' AND state = 'sending'",
    )).length;

    await mailSyncForTesting()!.runTick({});
    expect(await stillSending()).toBe(1);
    // The remainder is picked up next tick, oldest first. A row that has been `sending` for five
    // minutes is not in a hurry.
    await mailSyncForTesting()!.runTick({});
    expect(await stillSending()).toBe(0);
    // Settled, never re-attempted: the reaper records an outcome and never touches a transport.
    expect(callsFor(draft.draftId)).toEqual([]);

    await runSql("DELETE FROM sends WHERE send_id LIKE 'sn-batch-%'");
  });
});

describe('what a draft refuses', () => {
  it('will not discard a draft that is already sent, and withdraws the letter when it does discard', async () => {
    const draft = await newDraft();
    const letterId = (await requestSend(draft)).body.letterId!;
    const discarded = await api<{ ok: boolean; draft: DraftShape }>('DELETE', `/drafts/${draft.draftId}`);
    expect(discarded.status).toBe(200);
    expect(discarded.body.draft.state).toBe('discarded');
    await expect.poll(
      async () => (await mailLetters()).find((one) => one.id === letterId)?.answered?.actionId,
      { timeout: 15_000 },
    ).toBe('withdrawn');

    const sent = await newDraft();
    const sentLetter = (await requestSend(sent)).body.letterId!;
    expect(await answer(sentLetter, 'send')).toBe(200);
    await expect.poll(async () => (await draftOf(sent.draftId)).state, { timeout: 15_000 }).toBe('sent');
    const refused = await api<{ error: string }>('DELETE', `/drafts/${sent.draftId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('invalid');
  });

  it('refuses to ask about an account whose provider cannot send from it', async () => {
    const draft = await newDraft({ accountId: READONLY });
    const before = (await mailLetters()).length;
    const asked = await requestSend(draft);
    expect(asked.status).toBe(409);
    expect(asked.body.error).toBe('unsupported');
    // No letter was sent at all: a letter whose Send button is guaranteed to fail is worse than a
    // refusal, because the human has already decided by the time they find out.
    expect(await mailLetters()).toHaveLength(before);
    // Per ACCOUNT, not per provider: the same provider sends fine from the other account.
    expect(marks().accountCapabilityCalls).toContain(READONLY);
    const fine = await newDraft();
    expect((await requestSend(fine)).status).toBe(200);
  });

  it('refuses a draft with no recipient and one with neither subject nor body', async () => {
    const noRecipient = await newDraft({ to: [] });
    const asked = await requestSend(noRecipient);
    expect(asked.status).toBe(400);
    expect(asked.body.message).toContain('recipient');

    const empty = await newDraft({ subject: '', bodyMarkdown: '' });
    const emptyAsked = await requestSend(empty);
    expect(emptyAsked.status).toBe(400);
    expect(emptyAsked.body.message).toContain('subject or a body');
  });
});

describe('the send ledger is readable', () => {
  it('lists sends for an account with their approval and their outcome', async () => {
    const listed = await api<{ sends: SendShape[] }>('GET', `/sends?account=${encodeURIComponent(SENDER)}&limit=100`);
    expect(listed.status).toBe(200);
    expect(listed.body.sends.length).toBeGreaterThan(0);
    for (const send of listed.body.sends) {
      expect(send.accountId).toBe(SENDER);
      expect(send.idempotencyKey).toBe(`${send.draftId}:${send.revision}`);
      expect(['letter', 'console']).toContain(send.approvalKind);
      expect(['approved', 'sending', 'sent', 'failed', 'unknown']).toContain(send.state);
    }
    // Every key is unique across the whole file, which is the file's one summary claim.
    const keys = listed.body.sends.map((one) => one.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
