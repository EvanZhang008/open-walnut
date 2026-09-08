/**
 * The mail read path end to end, through a real server and a fixture provider plugin.
 *
 * What is graded here is the BASE, not a transport: a fake provider with an in-memory mailbox the
 * test controls is what lets these properties be stated exactly, and the IMAP half is pinned
 * separately (mail-imap.test.ts) plus once against a real account (mail-imap-live.test.ts).
 *
 * Each block below is a rule that has cost somebody a bug report:
 *
 * - Account setup is a PASS-THROUGH. The submitted values never land in the base's config, its
 *   database or its secret store; the provider owns them.
 * - A first backfill announces itself ONCE and does not claim "you have N new messages".
 * - A re-poll of a page already cached changes NOTHING, down to `updated_at`, and emits nothing.
 * - `reset: true` means the container's rows go before the resync lands.
 * - Bodies arrive lazily, land on disk, and feed a full-text index that finds a word which
 *   appears nowhere but deep inside the body.
 * - An `auth` failure parks that ONE account with one recoverable notification; a per-message
 *   body failure changes no health at all.
 * - Retention deletes rows, their body files AND their FTS entries.
 * - A replica polls nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-sync-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { listNotifications } from '../../src/core/notifications/store.js';
import { decodeMessageCursor, encodeMessageCursor, withBudget } from '../../src/integrations/mail/contract.js';
import { mailDatabaseForTesting } from '../../src/integrations/mail/db.js';
import { registerMailRoutes } from '../../src/integrations/mail/routes.js';
import { MailSync, type MailSyncHost } from '../../src/integrations/mail/sync.js';
import { mailSyncForTesting } from '../../src/integrations/mail/sync.js';
import { startServer, stopServer } from '../../src/web/server.js';

const FIXTURE_ID = 'mail-sync-fixture';
const ACCOUNT_ID = 'fake:one';
const BODY_DIR = () => path.join(WALNUT_HOME, 'plugin-data', 'mail', 'bodies');

interface FixtureMessage {
  uid: number;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  sentAt: number;
  /** The display name the LISTING carries. A conversation transport has this and no address. */
  fromName?: string;
  /** Addresses only the BODY read reveals, which is the gap-fill path. */
  bodyFrom?: { name?: string; address: string };
  bodyCc?: Array<{ name?: string; address: string }>;
  bodyReplyTo?: Array<{ name?: string; address: string }>;
}

/** Everything the test controls, and everything the fixture records, in one place. */
interface Fixture {
  uidvalidity: number;
  mailboxes: Array<{ path: string; role: string }>;
  messages: Record<string, FixtureMessage[]>;
  failPollWith: string | null;
  failBodyFor: string | null;
  /** messageId to ProviderErrorCode, and it STAYS: models a permanently unfetchable body. */
  bodyErrorFor: Record<string, string>;
  /** Every `sizeHint` the base passed to getBody, in order. */
  sizeHints: Array<number | undefined>;
  /** A poll parks on this until the test resolves it. Lets a delete land mid-tick. */
  gate: Promise<void> | null;
  /** Called before every poll answers, and may change the fixture's own state (e.g. the epoch). */
  beforePoll: ((state: Fixture) => void) | null;
  setupValues: Array<Record<string, string>>;
  polls: Array<{ accountId: string; mailbox: string; cursor: string | null }>;
  bodyCalls: string[];
  markRead: Array<[string, boolean]>;
  removed: string[];
  watchArmed: number;
  hint: ((hint: { mailbox: string }) => void) | null;
}

let server: HttpServer;
let port = 0;
const events: Array<{ name: string; data: Record<string, unknown> }> = [];

function marks(): Fixture {
  return (globalThis as unknown as { __mailSync: Fixture }).__mailSync;
}

function apiUrl(routePath: string): string {
  return `http://127.0.0.1:${port}/api/plugins/mail${routePath}`;
}

async function getJson<T>(routePath: string): Promise<{ status: number; body: T }> {
  const response = await fetch(apiUrl(routePath));
  return { status: response.status, body: await response.json() as T };
}

async function sendJson<T>(method: string, routePath: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(apiUrl(routePath), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as T };
}

async function rows<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  const db = mailDatabaseForTesting();
  expect(db, 'the mail plugin must have an open database').not.toBeNull();
  return db!.all<T>(sql);
}

/** Every file under the plugin's body cache, relative and sorted. */
async function bodyFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else out.push(path.relative(BODY_DIR(), absolute));
    }
  };
  await walk(BODY_DIR());
  return out.sort();
}

async function writeConfig(mail: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(
    CONFIG_FILE,
    yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, plugins: { mail } }),
    'utf-8',
  );
}

async function boot(mail: Record<string, unknown>): Promise<void> {
  await writeConfig(mail);
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}

/**
 * The fixture provider plugin: an in-memory mailbox with a real cursor.
 *
 * Its `poll` implements the same contract an IMAP server does, including the one detail that
 * makes cursors interesting: a cursor carries a generation (`<uidvalidity>:<lastUid>`), and a
 * generation change answers `reset: true` instead of silently returning nothing.
 */
async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Sync Fixture',
    description: 'An in-memory mailbox the test drives',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const S = () => globalThis.__mailSync;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function envelopeOf(mailbox, uidValidity, message) {
  return {
    messageId: mailbox + ':' + uidValidity + ':' + message.uid,
    rfcMessageId: '<m' + message.uid + '.' + mailbox + '@example.invalid>',
    mailboxId: mailbox,
    // A conversation-shaped transport names the participant and cannot name the address, which is
    // what an empty \`from\` models here.
    from: { name: message.fromName || 'Alice', address: message.from },
    to: [{ address: 'me@example.invalid' }],
    subject: message.subject,
    sentAt: message.sentAt,
    sentAtHeader: new Date(message.sentAt).toUTCString(),
    receivedAt: message.sentAt + 1000,
    flags: [],
    attachments: [],
    // The size the POLL reports, the way a real transport does (IMAP RFC822.SIZE). The base keeps
    // it and hands it back as getBody's sizeHint, so a provider can refuse an over-cap message
    // before it downloads anything.
    bodyBytes: Buffer.byteLength(message.text ?? '') + Buffer.byteLength(message.html ?? ''),
  };
}

function findMessage(messageId) {
  const state = S();
  for (const [mailbox, list] of Object.entries(state.messages)) {
    for (const message of list) {
      if (mailbox + ':' + state.uidvalidity + ':' + message.uid === messageId) return message;
    }
  }
  return null;
}

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const handle = base.registerProvider({
    id: 'fake',
    label: 'Fake',
    capabilities: {
      search: false, watch: true, drafts: false, markRead: true, flags: false,
      threads: false, send: false, sendAsReply: false, bodies: 'both', attachments: 'metadata',
    },
    setup: {
      fields: [
        { name: 'address', label: 'Address', kind: 'text' },
        { name: 'password', label: 'Password', kind: 'password' },
      ],
      submit: async (values) => {
        S().setupValues.push({ ...values });
        return {
          accountId: '${ACCOUNT_ID}',
          providerId: 'fake',
          displayName: 'Fixture mailbox',
          address: values.address,
          state: 'active',
        };
      },
    },
    listAccounts: async () => [{
      accountId: '${ACCOUNT_ID}', providerId: 'fake', displayName: 'Fixture mailbox',
      address: 'alice@example.invalid', state: 'active',
    }],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => S().mailboxes.map((box) => ({
      mailboxId: box.path,
      name: box.path,
      role: box.role,
      unread: 0,
      total: (S().messages[box.path] ?? []).length,
    })),
    poll: async (accountId, request) => {
      const state = S();
      state.polls.push({ accountId, mailbox: request.mailbox, cursor: request.cursor ?? null });
      if (state.gate) await state.gate;
      if (state.beforePoll) state.beforePoll(state);
      if (state.failPollWith) {
        const code = state.failPollWith;
        state.failPollWith = null;
        fail(code, 'the fixture was told to fail with ' + code);
      }
      const uidValidity = String(state.uidvalidity);
      let lastUid = 0;
      let reset = false;
      if (request.cursor) {
        const at = request.cursor.lastIndexOf(':');
        if (request.cursor.slice(0, at) !== uidValidity) reset = true;
        else lastUid = Number(request.cursor.slice(at + 1)) || 0;
      }

      const pending = (state.messages[request.mailbox] ?? [])
        .filter((message) => message.uid > lastUid)
        .sort((a, b) => a.uid - b.uid);
      const page = pending.slice(0, request.limit);
      const highest = page.length > 0 ? page[page.length - 1].uid : lastUid;
      return {
        messages: page.map((message) => envelopeOf(request.mailbox, uidValidity, message)),
        cursor: uidValidity + ':' + highest,
        more: page.length >= request.limit,
        ...(reset ? { reset: true } : {}),
      };
    },
    getBody: async (accountId, messageId, sizeHint) => {
      const state = S();
      state.bodyCalls.push(messageId);
      state.sizeHints.push(sizeHint);
      if (state.bodyErrorFor[messageId]) {
        fail(state.bodyErrorFor[messageId], 'the fixture will never hand over ' + messageId);
      }
      if (state.failBodyFor === messageId) fail('unreachable', 'the fixture cannot fetch that body');
      const message = findMessage(messageId);
      if (!message) fail('not-found', 'no such message: ' + messageId);
      const text = message.text ?? '';
      const html = message.html ?? '';
      return {
        format: html && text ? 'both' : html ? 'html' : 'text',
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        bytes: Buffer.byteLength(text) + Buffer.byteLength(html),
        // The addresses only a read of the thread reveals. A transport whose listing carries them
        // leaves all of these unset, which every other message in this file does.
        ...(message.bodyFrom ? { from: message.bodyFrom } : {}),
        ...(message.bodyCc ? { cc: message.bodyCc } : {}),
        ...(message.bodyReplyTo ? { replyTo: message.bodyReplyTo } : {}),
      };
    },
    markRead: async (accountId, messageId, read) => { S().markRead.push([messageId, read]); },
    watch: (accountId, onHint) => {
      const state = S();
      state.watchArmed += 1;
      state.hint = onHint;
      return { dispose: () => { state.watchArmed -= 1; state.hint = null; } };
    },
    send: async () => fail('unsupported', 'the fixture does not send'),
    removeAccount: async (accountId) => { S().removed.push(accountId); },
  });
  return { dispose: () => handle.dispose() };
}
`);
}

function message(uid: number, subject: string, extra: Partial<FixtureMessage> = {}): FixtureMessage {
  return {
    uid,
    from: 'alice@example.invalid',
    subject,
    text: `Body of ${subject}.`,
    // Deliberately spread across a week so `before` paging and the age cutoff have something
    // real to order by.
    sentAt: Date.UTC(2026, 0, 10 + uid, 9, 0, 0),
    ...extra,
  };
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  (globalThis as unknown as { __mailSync: Fixture }).__mailSync = {
    uidvalidity: 100,
    bodyErrorFor: {},
    sizeHints: [],
    gate: null,
    beforePoll: null,
    mailboxes: [{ path: 'INBOX', role: 'inbox' }, { path: 'Projects/2026', role: 'archive' }],
    messages: {
      INBOX: [message(1, 'Kickoff'), message(2, 'Second thoughts')],
      'Projects/2026': [message(1, 'Filed away')],
    },
    failPollWith: null,
    failBodyFor: null,
    setupValues: [],
    polls: [],
    bodyCalls: [],
    markRead: [],
    removed: [],
    watchArmed: 0,
    hint: null,
  };
  await writeFixtureProvider();
  bus.subscribe('mail-sync-observer', (event) => {
    if (event.name.startsWith('plugin:mail:')) {
      events.push({ name: event.name.slice('plugin:mail:'.length), data: event.data as Record<string, unknown> });
    }
  }, { global: true, interest: ['plugin:mail:'] });
  // A long interval on purpose: every tick in this file is driven explicitly, so a background
  // timer cannot land between an action and its assertion.
  await boot({ poll_interval_seconds: 600, max_rows_per_account: 50, retention_days: 3650 });
}, 180_000);

afterAll(async () => {
  bus.unsubscribe('mail-sync-observer');
  await stopServer();
  delete (globalThis as unknown as { __mailSync?: Fixture }).__mailSync;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

function eventsOf(name: string): Array<Record<string, unknown>> {
  return events.filter((event) => event.name === name).map((event) => event.data);
}

describe('account setup passes the values through and keeps none of them', () => {
  it('hands the values to the provider, mirrors the account, and kicks a first sync', async () => {
    events.length = 0;
    const created = await sendJson<{ account: { accountId: string; address: string } }>('POST', '/accounts', {
      providerId: 'fake',
      values: { address: 'alice@example.invalid', password: 'app-password-not-the-real-one' },
    });

    expect(created.status).toBe(201);
    expect(created.body.account.accountId).toBe(ACCOUNT_ID);
    expect(marks().setupValues).toEqual([
      { address: 'alice@example.invalid', password: 'app-password-not-the-real-one' },
    ]);

    // The account is visible with health and an unread count, and NO credential.
    const listed = await getJson<{ accounts: Array<Record<string, unknown>> }>('/accounts');
    expect(listed.body.accounts).toHaveLength(1);
    expect(listed.body.accounts[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      providerId: 'fake',
      address: 'alice@example.invalid',
      state: 'active',
      unread: 0,
    });
    expect(JSON.stringify(listed.body.accounts)).not.toContain('app-password');
  });

  it('never writes the submitted values into the base config, database or secret store', async () => {
    // The whole file, not a key lookup: a credential smuggled into a payload blob or a nested
    // config key would pass a shaped assertion and fail this one.
    const configText = await fsp.readFile(CONFIG_FILE, 'utf-8');
    expect(configText).not.toContain('app-password');

    const dump = JSON.stringify(await rows('SELECT * FROM accounts'));
    expect(dump).not.toContain('app-password');

    // The base has no secret store of its own at all: the provider writes its own.
    const secretDir = path.join(WALNUT_HOME, 'secrets', 'plugins');
    const secretFiles = await fsp.readdir(secretDir).catch(() => [] as string[]);
    expect(secretFiles).not.toContain('mail.json');
  });
});

describe('the first sync', () => {
  it('backfills envelopes and emits sync-completed only', async () => {
    await expect.poll(async () => (await rows('SELECT rowid FROM messages')).length, { timeout: 20_000 }).toBe(3);

    const listed = await getJson<{ messages: Array<Record<string, unknown>>; nextBefore?: number }>(
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=INBOX`,
    );
    expect(listed.body.messages.map((one) => one.subject)).toEqual(['Second thoughts', 'Kickoff']);
    expect(listed.body.messages[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      mailboxId: 'INBOX',
      rfcMessageId: '<m2.INBOX@example.invalid>',
      from: { name: 'Alice', address: 'alice@example.invalid' },
    });
    // Instants plus the header verbatim, never wall time.
    expect(listed.body.messages[0]!.sentAt).toBe(Date.UTC(2026, 0, 12, 9, 0, 0));
    expect(listed.body.messages[0]!.sentAtHeader).toBe(new Date(Date.UTC(2026, 0, 12, 9, 0, 0)).toUTCString());
    // A short page offers no cursor: a console that got one would ask for an empty page forever.
    expect(listed.body.nextBefore).toBeUndefined();

    // The POLL itself fetched no bodies. Only the tick's bounded inbox prefetch did, so a
    // container nobody is looking at stays envelope-only however long the account lives: adding
    // an account costs a page of headers, not a mailbox-sized download.
    expect(marks().bodyCalls.every((id) => id.startsWith('INBOX:'))).toBe(true);
    const filed = await getJson<{ messages: Array<{ hasBody: boolean }> }>(
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=${encodeURIComponent('Projects/2026')}`,
    );
    expect(filed.body.messages).toHaveLength(1);
    expect(filed.body.messages[0]!.hasBody).toBe(false);

    // The mailbox list came from the provider, with roles and a cursor stored per container.
    const mailboxes = await getJson<{ mailboxes: Array<Record<string, unknown>> }>(
      `/mailboxes?account=${encodeURIComponent(ACCOUNT_ID)}`,
    );
    expect(mailboxes.body.mailboxes.map((one) => [one.mailboxId, one.role])).toEqual([
      ['INBOX', 'inbox'],
      ['Projects/2026', 'archive'],
    ]);

    // ONE event per container, and NOT a word about "new messages": a backfill is the account
    // being added, not news.
    expect(eventsOf('sync-completed')).toEqual([
      expect.objectContaining({ accountId: ACCOUNT_ID, mailboxId: 'INBOX', added: 2, updated: 0 }),
      expect.objectContaining({ accountId: ACCOUNT_ID, mailboxId: 'Projects/2026', added: 1, updated: 0 }),
    ]);
    expect(eventsOf('messages-received')).toEqual([]);
    expect(eventsOf('account-changed')).toEqual([{ accountId: ACCOUNT_ID, action: 'added' }]);
  });

  it('is a no-op the second time, down to updated_at, and emits nothing', async () => {
    const before = await rows<{ message_id: string; updated_at: number }>(
      'SELECT message_id, updated_at FROM messages ORDER BY message_id',
    );
    const pollsBefore = marks().polls.length;
    events.length = 0;

    const refreshed = await sendJson<{ ok: boolean; completed: boolean; added: number; updated: number }>('POST', '/refresh', {
      accountId: ACCOUNT_ID,
    });

    expect(refreshed.body).toMatchObject({ ok: true, completed: true, added: 0, updated: 0 });
    // It really did ask the provider: this is idempotence, not a skipped poll.
    expect(marks().polls.length).toBeGreaterThan(pollsBefore);
    expect(await rows('SELECT message_id, updated_at FROM messages ORDER BY message_id')).toEqual(before);
    // A poller that announces "I polled and nothing happened" every two minutes forever is a bus
    // storm with a heartbeat's self-image.
    expect(events).toEqual([]);
  });
});

describe('new mail', () => {
  it('emits one messages-received per account per tick, with at most five headlines', async () => {
    for (let uid = 3; uid <= 8; uid += 1) {
      marks().messages.INBOX.push(message(uid, `Update ${uid}`, {
        text: `Nothing to see in the first paragraph.\n\nThe word cranberry sits deep in message ${uid}.`,
      }));
    }
    events.length = 0;

    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });

    const received = eventsOf('messages-received');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ accountId: ACCOUNT_ID, count: 6 });
    // Six arrived; five headlines ride the event. One event per message would have been six
    // events here and thousands on a real first sync.
    expect((received[0]!.headlines as unknown[]).length).toBe(5);
    expect((received[0]!.headlines as Array<{ subject: string }>)[0]!.subject).toBe('Update 3');
    expect(await rows('SELECT rowid FROM messages')).toHaveLength(9);
  });

  it('pages with before, and offers a cursor only when the page filled', async () => {
    const first = await getJson<{
      messages: Array<{ sentAt: number; subject: string; messageId: string }>;
      nextBefore?: string;
    }>(`/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=INBOX&limit=3`);
    expect(first.body.messages.map((one) => one.subject)).toEqual(['Update 8', 'Update 7', 'Update 6']);
    // The cursor is OPAQUE to a client now. It is decoded here, once, only to state what it
    // carries: the whole sort key rather than just a timestamp, which is what lets the next page
    // resume exactly where this one stopped even when several messages share a second.
    expect(typeof first.body.nextBefore).toBe('string');
    expect(Buffer.from(first.body.nextBefore!, 'base64url').toString('utf8')).toBe(
      [first.body.messages[2]!.sentAt, first.body.messages[2]!.messageId].join('\u0000'),
    );

    const second = await getJson<{ messages: Array<{ subject: string }> }>(
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=INBOX&limit=3&before=${first.body.nextBefore}`,
    );
    expect(second.body.messages.map((one) => one.subject)).toEqual(['Update 5', 'Update 4', 'Update 3']);
  });

  it('pages past messages that share a timestamp, and still honours a bare-number cursor', async () => {
    // Three messages at the SAME instant, which is not exotic: a newsletter blast and anything
    // filed by a rule all land on one second. A cursor holding only `sent_at` cannot express
    // "after the second of these", so the old `sent_at < ?` paging skipped the rest of the tie
    // outright and the message was simply missing from the list forever.
    const tie = Date.UTC(2026, 5, 1, 12, 0, 0);
    for (const uid of [1, 2, 3]) {
      await mailDatabaseForTesting()!.run(
        'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr,'
        + ' subject, snippet, sent_at, flags_json, attachments_json, updated_at, envelope_hash)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          ACCOUNT_ID, `Ties:1:${uid}`, `<tie${uid}@example.invalid>`, 'Ties',
          'alice@example.invalid', `Tie ${uid}`, '', tie, '[]', '[]', tie, `hash-tie-${uid}`,
        ],
      );
    }

    const first = await getJson<{ messages: Array<{ subject: string }>; nextBefore?: string }>(
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=Ties&limit=2`,
    );
    expect(first.body.messages.map((one) => one.subject)).toEqual(['Tie 3', 'Tie 2']);
    const second = await getJson<{ messages: Array<{ subject: string }>; nextBefore?: string }>(
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=Ties&limit=2&before=${first.body.nextBefore}`,
    );
    expect(second.body.messages.map((one) => one.subject)).toEqual(['Tie 1']);

    // A console tab that was open across the deploy still holds a bare number, and answering that
    // with a 400 would break paging in the one window nobody can redeploy. It pages the way it
    // always did: strictly older, ties included.
    const legacy = await getJson<{ messages: Array<{ subject: string }> }>(
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=Ties&limit=5&before=${tie + 1}`,
    );
    expect(legacy.body.messages.map((one) => one.subject)).toEqual(['Tie 3', 'Tie 2', 'Tie 1']);

    // And a legacy cursor sitting exactly ON the tie returns NOTHING from it, which is what "the
    // page I already have ended here" has always meant. The obvious implementation (decode the bare
    // number to a high sentinel message id, so the tie half of the predicate is always true) turns
    // this into "at or before" and re-serves the three rows the caller was just given, forever.
    const onTheTie = await getJson<{ messages: Array<{ subject: string }> }>(
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=Ties&limit=5&before=${tie}`,
    );
    expect(onTheTie.body.messages).toEqual([]);

    await mailDatabaseForTesting()!.run("DELETE FROM messages WHERE mailbox_id = 'Ties'");
  });
});

describe('the page cursor', () => {
  it('round-trips the whole sort key, and decodes a legacy number to the empty id', () => {
    expect(decodeMessageCursor(encodeMessageCursor({ sentAt: 17, messageId: 'INBOX:9:2' })))
      .toEqual({ sentAt: 17, messageId: 'INBOX:9:2' });

    // The EMPTY id, not a high sentinel. `message_id < ''` is never true, so the predicate reduces
    // to exactly `sent_at < ?`: the legacy form keeps its old meaning. A `\uFFFF` sentinel is wrong
    // twice over, and the second reason is the one that bites: SQLite compares TEXT as UTF-8 bytes,
    // so an id starting with an astral character sorts ABOVE char(65535).
    expect(decodeMessageCursor('1768554000000')).toEqual({ sentAt: 1768554000000, messageId: '' });
    expect(Buffer.from('\u{1F600}', 'utf8').compare(Buffer.from('\uFFFF', 'utf8'))).toBe(1);

    // Anything the server did not issue is no cursor at all, so a page starts at the top rather
    // than at a position a caller invented.
    for (const junk of [undefined, '', '0', '-4', 'not base64url', Buffer.from('99', 'utf8').toString('base64url')]) {
      expect(decodeMessageCursor(junk), `cursor ${JSON.stringify(junk)}`).toBeUndefined();
    }
  });
});

describe('a route budget', () => {
  it('answers on time and still handles the loser, so a late failure is not an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on('unhandledRejection', onRejection);
    try {
      const late: unknown[] = [];
      // A write that fails AFTER the route already answered. Nothing is left waiting on this
      // promise, and an unhandled rejection here would be a process-level warning (with a strict
      // runtime flag, an exit) for something that was merely slow.
      const slowFailure = new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('the provider gave up long after the 202')), 30);
      });
      expect(await withBudget(slowFailure, 5, (outcome) => late.push(outcome))).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(late).toHaveLength(1);
      expect((late[0] as { error?: Error }).error?.message).toContain('long after the 202');
      expect(rejections).toEqual([]);

      // A late SUCCESS is reported the same way: the work still happened, and the log line is the
      // only place anyone will ever see it.
      const slowValue = new Promise<string>((resolve) => { setTimeout(() => resolve('done'), 20); });
      expect(await withBudget(slowValue, 5, (outcome) => late.push(outcome))).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(late[1]).toEqual({ value: 'done' });

      // And work that finishes inside the budget is returned, with nothing reported late.
      expect(await withBudget(Promise.resolve('fast'), 5_000, (outcome) => late.push(outcome))).toBe('fast');
      expect(late).toHaveLength(2);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('the numbers an account reports', () => {
  it('keeps `unread` as every mailbox summed and adds `unreadInbox` for the badge', async () => {
    // A badge built from the total tells the human they have 43 unread mails when 40 of them are
    // filed somewhere they will never look. Both numbers are kept: the total is still the honest
    // cache statistic, and the badge is what a sidebar means.
    await mailDatabaseForTesting()!.run(
      "UPDATE mailboxes SET unread = 3 WHERE account_id = ? AND mailbox_id = 'INBOX'", [ACCOUNT_ID],
    );
    await mailDatabaseForTesting()!.run(
      "UPDATE mailboxes SET unread = 40 WHERE account_id = ? AND role = 'archive'", [ACCOUNT_ID],
    );

    const listed = await getJson<{ accounts: Array<{ unread: number; unreadInbox: number }> }>('/accounts');
    expect(listed.body.accounts[0]).toMatchObject({ unread: 43, unreadInbox: 3 });

    await mailDatabaseForTesting()!.run('UPDATE mailboxes SET unread = 0 WHERE account_id = ?', [ACCOUNT_ID]);
  });
});

describe('bodies', () => {
  const bodyMessageId = 'INBOX:100:5';

  it('are fetched on first read, written as files, and snipped to at most 2 KB', async () => {
    // The tick prefetches the newest inbox bodies, so this one may already be on disk. Either
    // way the read has to answer with the body, which is the contract the console depends on.
    const read = await getJson<{
      message: { hasBody: boolean; snippet: string };
      body: { format: string; text?: string; bytes: number; truncated: boolean } | null;
    }>(`/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(bodyMessageId)}`);

    expect(read.status).toBe(200);
    expect(read.body.body?.format).toBe('text');
    expect(read.body.body?.text).toContain('cranberry');
    expect(read.body.body?.truncated).toBe(false);
    expect(read.body.message.snippet.length).toBeLessThanOrEqual(2048);
    expect(read.body.message.snippet).not.toContain('\n');

    const files = await bodyFiles();
    expect(files.length).toBeGreaterThan(0);
    // bodies/<accountHash>/<yyyymm>/<hash>.txt — the account is hashed, not spelled out: a
    // directory name is the one part of a cache that shows up in a screen share.
    expect(files[0]).toMatch(/^[0-9a-f]{12}\/\d{6}\/[0-9a-f]{32}\.txt$/);
    expect(files.join(' ')).not.toContain('alice');

    const row = await rows<{ body_ref: string; body_bytes: number }>(
      `SELECT body_ref, body_bytes FROM messages WHERE message_id = '${bodyMessageId}'`,
    );
    expect(row[0]!.body_ref).toMatch(/^bodies\//);
    expect(row[0]!.body_bytes).toBeGreaterThan(0);
  });

  it('feed a full-text index that finds a word only the body contains', async () => {
    const found = await getJson<{ messages: Array<{ messageId: string }>; source: string }>(
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=cranberry`,
    );
    expect(found.body.source).toBe('cache');
    expect(found.body.messages.map((one) => one.messageId)).toContain(bodyMessageId);

    // A provider with no search capability still answers a search, and says where the answer
    // came from so a console can label it.
    const missing = await getJson<{ messages: unknown[] }>(
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=gooseberry`,
    );
    expect(missing.body.messages).toEqual([]);

    // A query full of FTS5 syntax is DATA, not a query language: an unquoted user string reaches
    // SQLite as an expression and a stray character answers with a 500 instead of no results.
    const hostile = await getJson<{ messages: unknown[] }>(
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=${encodeURIComponent('cranberry AND "(*')}`,
    );
    expect(hostile.status).toBe(200);
  });

  it('report a per-message failure without touching account health', async () => {
    // A container the prefetch never touches, so this read really does reach the provider.
    const filedId = 'Projects/2026:100:1';
    marks().failBodyFor = filedId;
    const read = await getJson<{ message: { hasBody: boolean }; body: null; bodyError?: string }>(
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(filedId)}`,
    );
    marks().failBodyFor = null;

    // The envelope is real data the caller asked for: losing it because one fetch failed turns a
    // degraded read into a broken screen.
    expect(read.status).toBe(200);
    expect(read.body.message.hasBody).toBe(false);
    expect(read.body.body).toBeNull();
    expect(read.body.bodyError).toBe('unreachable');

    const accounts = await getJson<{ accounts: Array<{ state: string }> }>('/accounts');
    expect(accounts.body.accounts[0]!.state).toBe('active');
  });

  it('drop a first line that only repeats the subject before cutting the snippet', async () => {
    // Almost every HTML newsletter opens with an `<h1>` holding its own subject, so the extracted
    // text began with it and the list read "Weekly digest. Weekly digest, and then the actual...".
    // Half the preview was spent on a string already rendered two pixels away.
    const sentAt = Date.UTC(2026, 2, 3, 8, 0, 0);
    const filesBefore = new Set(await bodyFiles());
    marks().messages.Digest = [{
      uid: 1,
      from: 'alice@example.invalid',
      subject: 'Weekly digest',
      text: '',
      html: '<h1>Weekly digest</h1><p>Real content starts here.</p>',
      sentAt,
    }];
    await mailDatabaseForTesting()!.run(
      'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr,'
      + ' subject, snippet, sent_at, flags_json, attachments_json, updated_at, envelope_hash)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        ACCOUNT_ID, 'Digest:100:1', '<digest@example.invalid>', 'Digest', 'alice@example.invalid',
        'Weekly digest', '', sentAt, '[]', '[]', sentAt, 'hash-digest',
      ],
    );

    const read = await getJson<{ message: { snippet: string }; body: { html?: string } | null }>(
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent('Digest:100:1')}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.message.snippet).toBe('Real content starts here.');
    expect(read.body.message.snippet).not.toContain('Weekly digest');
    // Only the SNIPPET changes. The stored body keeps every byte, so the heading is still
    // findable and still rendered.
    expect(read.body.body?.html).toContain('<h1>Weekly digest</h1>');

    // Take the body FILE with the row. A raw row delete skips the plugin's own cleanup, and the
    // orphan it leaves behind fails the two "nothing survives an account delete" checks later in
    // this file, which is a real assertion about real bookkeeping and must not be blunted here.
    await mailDatabaseForTesting()!.run("DELETE FROM messages WHERE mailbox_id = 'Digest'");
    for (const file of await bodyFiles()) {
      if (!filesBefore.has(file)) await fsp.rm(path.join(BODY_DIR(), file), { force: true });
    }
    delete marks().messages.Digest;
  });
});

describe('read flags', () => {
  it('go to the provider first, then to the cache', async () => {
    const flagged = await sendJson<{ ok: boolean; message: { flags: string[] } }>(
      'POST',
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent('INBOX:100:2')}/read`,
      { read: true },
    );
    expect(flagged.status).toBe(200);
    expect(marks().markRead).toEqual([['INBOX:100:2', true]]);
    expect(flagged.body.message.flags).toContain('\\Seen');

    const listed = await getJson<{ messages: Array<{ messageId: string; flags: string[] }> }>(
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=INBOX&limit=50`,
    );
    expect(listed.body.messages.find((one) => one.messageId === 'INBOX:100:2')!.flags).toContain('\\Seen');
  });
});

describe('an auth failure', () => {
  it('parks that account with one recoverable notification, and the next good poll retires it', async () => {
    events.length = 0;
    marks().failPollWith = 'auth';

    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });

    const accounts = await getJson<{ accounts: Array<{ state: string; health?: { state: string } }> }>('/accounts');
    expect(accounts.body.accounts[0]!.state).toBe('auth-required');
    expect(accounts.body.accounts[0]!.health?.state).toBe('auth-required');
    expect(eventsOf('account-health')).toEqual([{ accountId: ACCOUNT_ID, state: 'auth-required' }]);

    const feed = (await listNotifications()).feed;
    const card = feed.filter((one) => one.dedupKey === `plugin:mail:account-auth:${ACCOUNT_ID}`);
    // ONE card, keyed per account, recoverable. A card per tick is a wall of red that says the
    // same thing forty times.
    expect(card).toHaveLength(1);
    expect(card[0]!.kind).toBe('operation-error');
    expect(card[0]!.recoveryKey).toBe('plugin:mail');
    expect(card[0]!.resolved).toBeUndefined();

    // The TIMER stops asking. Retrying a wrong password every two minutes is how an account gets
    // locked out, so a parked account waits for the human.
    const pollsBefore = marks().polls.length;
    await mailSyncForTesting()!.runTick({});
    expect(marks().polls.length).toBe(pollsBefore);

    // A human-driven refresh is the recovery path, and it clears everything the park set.
    events.length = 0;
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });
    expect(marks().polls.length).toBeGreaterThan(pollsBefore);
    expect((await getJson<{ accounts: Array<{ state: string }> }>('/accounts')).body.accounts[0]!.state).toBe('active');
    expect(eventsOf('account-health')).toEqual([{ accountId: ACCOUNT_ID, state: 'active' }]);

    const retired = (await listNotifications()).feed
      .find((one) => one.dedupKey === `plugin:mail:account-auth:${ACCOUNT_ID}`);
    expect(retired?.resolved).toBe('recovered');
  }, 60_000);
});

describe('a watch hint', () => {
  it('does no I/O in the callback and kicks the loop instead', async () => {
    await expect.poll(() => marks().watchArmed, { timeout: 10_000 }).toBe(1);
    const pollsBefore = marks().polls.length;

    marks().hint!({ mailbox: 'INBOX' });

    // The rule: the callback runs on the provider's own stack, so it may only flip a flag. If it
    // fetched, this number would already have moved.
    expect(marks().polls.length).toBe(pollsBefore);
    await expect.poll(() => marks().polls.length, { timeout: 10_000 }).toBeGreaterThan(pollsBefore);
  }, 30_000);
});

describe('a voided cursor', () => {
  it('drops the container rows before the resync lands', async () => {
    const before = await rows<{ message_id: string }>("SELECT message_id FROM messages WHERE mailbox_id = 'INBOX'");
    expect(before.every((row) => row.message_id.startsWith('INBOX:100:'))).toBe(true);

    // A new generation: every UID we hold is void, which is exactly what an IMAP UIDVALIDITY
    // change means and what `reset: true` says on the wire.
    marks().uidvalidity = 200;
    marks().messages.INBOX = [message(1, 'After the reset'), message(2, 'Also after')];

    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });

    const after = await rows<{ message_id: string }>("SELECT message_id FROM messages WHERE mailbox_id = 'INBOX'");
    expect(after.map((row) => row.message_id).sort()).toEqual(['INBOX:200:1', 'INBOX:200:2']);
    // Their body files went with them, so a reset does not leak the old generation's bytes.
    const cursor = await rows<{ cursor: string }>("SELECT cursor FROM mailboxes WHERE mailbox_id = 'INBOX'");
    expect(cursor[0]!.cursor).toBe('200:2');

    // And the FTS index no longer answers for the deleted generation.
    const found = await getJson<{ messages: unknown[] }>(
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=cranberry`,
    );
    expect(found.body.messages).toEqual([]);
  }, 60_000);
});

describe('an epoch change discovered mid-backfill', () => {
  it('leaves the old cursor alone so the next tick sees the reset at page 0', async () => {
    // A backfill deep enough to need several pages: PAGE_LIMIT is 50, so 60 messages means page 0
    // fills and there is a page 1 behind it.
    marks().uidvalidity = 400;
    marks().messages.INBOX = Array.from({ length: 60 }, (_, at) => message(at + 1, `Bulk ${at + 1}`));
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });
    expect((await rows<{ cursor: string }>(
      "SELECT cursor FROM mailboxes WHERE mailbox_id = 'INBOX'",
    ))[0]!.cursor).toBe('400:60');

    // Another 60 at the SAME epoch, so the next tick fills page 0 again, and the epoch flips only
    // once page 0 has landed. That is the case: a container that changes generation between two
    // pages of one backfill.
    marks().messages.INBOX = Array.from({ length: 120 }, (_, at) => message(at + 1, `Bulk ${at + 1}`));
    let polls = 0;
    marks().beforePoll = (state) => { if ((polls += 1) >= 2) state.uidvalidity = 500; };
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });
    marks().beforePoll = null;

    // The cursor is still on the OLD epoch. Writing the new-epoch cursor while dropping the reset
    // is what used to happen, and it left the old epoch's rows in the cache under a cursor
    // claiming all was well: nothing would ever resync that container again.
    const held = await rows<{ cursor: string }>("SELECT cursor FROM mailboxes WHERE mailbox_id = 'INBOX'");
    expect(held[0]!.cursor).toMatch(/^400:/);
    expect((await rows<{ message_id: string }>(
      "SELECT message_id FROM messages WHERE mailbox_id = 'INBOX' LIMIT 1",
    ))[0]!.message_id.startsWith('INBOX:400:')).toBe(true);

    // The next tick meets the reset at page 0, where it is handled: old rows go, new ones land.
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });
    const after = await rows<{ message_id: string }>("SELECT message_id FROM messages WHERE mailbox_id = 'INBOX'");
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((row) => row.message_id.startsWith('INBOX:500:'))).toBe(true);
    expect((await rows<{ cursor: string }>(
      "SELECT cursor FROM mailboxes WHERE mailbox_id = 'INBOX'",
    ))[0]!.cursor).toMatch(/^500:/);
  }, 120_000);
});

describe('a body the provider will never hand over', () => {
  it('is asked for exactly once, however many ticks go by', async () => {
    marks().uidvalidity = 600;
    marks().messages.INBOX = [message(1, 'A photo album')];
    marks().bodyErrorFor = { 'INBOX:600:1': 'too-large' };
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });

    const asked = () => marks().bodyCalls.filter((id) => id === 'INBOX:600:1').length;
    expect(asked()).toBe(1);

    // Three more ticks, each of which runs the body prefetch over the newest bodyless inbox rows.
    // Without a persisted marker this is where a photo-heavy inbox becomes tens of megabytes an
    // hour against the user's own server, forever.
    for (let round = 0; round < 3; round += 1) await mailSyncForTesting()!.runTick({ force: true });
    expect(asked()).toBe(1);

    // The read path answers from the marker too, and says why.
    const read = await getJson<{ message: { hasBody: boolean; bodyError?: string }; body: null; bodyError?: string }>(
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent('INBOX:600:1')}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.bodyError).toBe('too-large');
    expect(read.body.message.bodyError).toBe('too-large');
    expect(asked()).toBe(1);

    // `?retry=1` is the ONE way to ask again: an explicit human action, never a poll.
    marks().bodyErrorFor = {};
    const retried = await getJson<{ body: { text?: string } | null }>(
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent('INBOX:600:1')}?retry=1`,
    );
    expect(asked()).toBe(2);
    expect(retried.body.body?.text).toContain('A photo album');

    // And the size the poll reported reaches the provider, so a transport can refuse before it
    // downloads anything at all.
    expect(marks().sizeHints.some((hint) => typeof hint === 'number')).toBe(true);
  }, 120_000);
});

describe('an envelope-only update', () => {
  it('keeps the stored body findable, and keeps its format and truncation', async () => {
    marks().uidvalidity = 700;
    marks().messages.INBOX = [message(1, 'Quarterly', {
      text: 'the word persimmon is only in the text half',
      html: '<p>the word persimmon is only in the <b>text</b> half</p>',
    })];
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });
    const id = encodeURIComponent('INBOX:700:1');
    const first = await getJson<{ body: { format: string } }>(
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${id}`,
    );
    expect(first.body.body.format).toBe('both');
    expect((await getJson<{ messages: unknown[] }>(
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=persimmon`,
    )).body.messages).toHaveLength(1);

    // The SAME message, re-polled with a changed subject. The cursor is rewound by hand because
    // the fixture only hands back UIDs above it, and what is being graded is the base's update
    // path: an envelope update used to rewrite the FTS row with an empty body_text and rebuild the
    // payload without the body's format, so a renamed subject silently deleted the body from
    // search and downgraded a 'both' body to 'html'.
    await mailDatabaseForTesting()!.run(
      "UPDATE mailboxes SET cursor = NULL WHERE mailbox_id = 'INBOX'",
    );
    marks().messages.INBOX = [message(1, 'Quarterly (revised)', {
      text: 'the word persimmon is only in the text half',
      html: '<p>the word persimmon is only in the <b>text</b> half</p>',
    })];
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });

    const again = await getJson<{ message: { subject: string }; body: { format: string } }>(
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${id}`,
    );
    expect(again.body.message.subject).toBe('Quarterly (revised)');
    expect(again.body.body.format).toBe('both');
    expect((await getJson<{ messages: unknown[] }>(
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=persimmon`,
    )).body.messages).toHaveLength(1);
  }, 120_000);
});

/**
 * A conversation-shaped transport lists a thread's participants as display names with NO address,
 * and only a read of the thread returns a real `from`. Before `MailBody` could carry addresses the
 * stored envelope kept an empty one forever: cache search never matched the sender and Reply had
 * nothing to prefill.
 *
 * Every message below lives in `Projects/2026`, whose role is `archive`, so the tick's inbox
 * prefetch never touches it and each body fetch here is the one the test asked for.
 */
describe('a listing that cannot name an address', () => {
  const FILED = 'Projects/2026';
  const gapId = `${FILED}:900:1`;
  const namedId = `${FILED}:900:2`;
  const junkId = `${FILED}:900:3`;

  function readMessage(messageId: string) {
    return getJson<{
      message: {
        from: { name?: string; address: string };
        cc?: Array<{ address: string }>;
        replyTo?: Array<{ address: string }>;
      };
      body: { text?: string } | null;
    }>(`/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(messageId)}`);
  }

  function filedList() {
    return getJson<{ messages: Array<{ messageId: string; from: { name?: string; address: string } }> }>(
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&mailbox=${encodeURIComponent(FILED)}`,
    );
  }

  function searchFor(query: string) {
    return getJson<{ messages: Array<{ messageId: string }> }>(
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=${encodeURIComponent(query)}`,
    );
  }

  // The fixture's mailbox outlives this block and the retention case downstream counts rows, so the
  // container goes back to the one message the rest of the file expects to find in it. The rows
  // themselves are dropped by the next epoch change, which resets every container.
  afterAll(() => {
    marks().messages[FILED] = [message(1, 'Filed away')];
  });

  it('fills the sender from the body, indexes it, and cannot be erased by a later empty one', async () => {
    marks().uidvalidity = 900;
    marks().messages[FILED] = [
      message(1, 'A thread with no sender address', {
        from: '',
        fromName: 'Ann',
        text: 'the word tamarind is only in this body',
        bodyFrom: { name: 'Ann', address: 'ann@example.invalid' },
        // One usable, one that is not an address at all: the good one is kept and the other is
        // dropped, rather than the whole field being refused or the junk being stored.
        bodyCc: [{ address: 'carol@example.invalid' }, { address: 'not an address' }],
        bodyReplyTo: [{ address: 'thread-42@example.invalid' }],
      }),
      message(2, 'A thread the listing named', {
        from: 'bob@example.invalid',
        bodyFrom: { name: 'Someone else', address: 'someone-else@example.invalid' },
      }),
      message(3, 'A thread whose body address is junk', {
        from: '',
        fromName: 'Cal',
        bodyFrom: { name: 'Cal', address: 'cal at example dot invalid' },
      }),
    ];
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });

    // The envelope as the listing had it: a name, and no address anywhere.
    const listed = await filedList();
    expect(listed.body.messages.find((one) => one.messageId === gapId)!.from)
      .toEqual({ name: 'Ann', address: '' });
    expect((await searchFor('ann@example.invalid')).body.messages).toEqual([]);

    // The body read is the first thing that can name the sender, and the answer that learned it
    // already carries it: the row it was built from predates the fetch by milliseconds.
    const first = await readMessage(gapId);
    expect(first.status).toBe(200);
    expect(first.body.message.from).toEqual({ name: 'Ann', address: 'ann@example.invalid' });
    expect(first.body.message.cc).toEqual([{ address: 'carol@example.invalid' }]);
    expect(first.body.message.replyTo).toEqual([{ address: 'thread-42@example.invalid' }]);

    // It was WRITTEN, not just answered: the next list carries it, and so does the index a human
    // searches, which is the whole reason the sender matters more than a rendered header.
    expect((await filedList()).body.messages.find((one) => one.messageId === gapId)!.from)
      .toEqual({ name: 'Ann', address: 'ann@example.invalid' });
    expect((await searchFor('ann@example.invalid')).body.messages.map((one) => one.messageId))
      .toEqual([gapId]);

    // A SECOND body fetch that cannot name the sender either must not erase what the first one
    // learned. The body_ref is cleared by hand because a stored body short-circuits the read, and
    // what is graded is the write: `COALESCE(NULLIF(...))` keeps the value already in the column.
    marks().messages[FILED]![0]!.bodyFrom = { name: 'Ann', address: '' };
    await mailDatabaseForTesting()!.run(
      'UPDATE messages SET body_ref = NULL, body_bytes = NULL WHERE account_id = ? AND message_id = ?',
      [ACCOUNT_ID, gapId],
    );
    const again = await readMessage(gapId);
    expect(again.body.body?.text).toContain('tamarind');
    expect(again.body.message.from).toEqual({ name: 'Ann', address: 'ann@example.invalid' });
    expect((await rows<{ from_addr: string }>(
      `SELECT from_addr FROM messages WHERE message_id = '${gapId}'`,
    ))[0]!.from_addr).toBe('ann@example.invalid');
  }, 120_000);

  it('leaves an address the listing already had, and drops one the body malformed', async () => {
    // GAP FILL, never a correction. A body that names a different sender than the listing did must
    // not be able to rewrite who a stored message came from.
    const named = await readMessage(namedId);
    expect(named.status).toBe(200);
    expect(named.body.message.from).toEqual({ name: 'Alice', address: 'bob@example.invalid' });

    // And an address that fails the base's own shape check is dropped: it would end up in a `from`
    // a reply is aimed at, so a value nothing can send to is worse than the hole it would fill.
    const junk = await readMessage(junkId);
    expect(junk.status).toBe(200);
    expect(junk.body.message.from).toEqual({ name: 'Cal', address: '' });
    expect((await rows<{ from_addr: string }>(
      `SELECT from_addr FROM messages WHERE message_id = '${junkId}'`,
    ))[0]!.from_addr).toBe('');
  }, 60_000);

  it('keeps the filled sender through a later envelope update that still cannot name one', async () => {
    // Any change to the envelope (a flag, an edited subject) rewrites `from` from the LISTING, which
    // for this transport is a name with no address. Blanking the column there loses the fill for
    // good, because the body is already stored and nothing would ever fetch it again.
    marks().messages[FILED]![0]!.subject = 'A thread with no sender address (edited)';
    await mailDatabaseForTesting()!.run(
      'UPDATE mailboxes SET cursor = NULL WHERE account_id = ? AND mailbox_id = ?',
      [ACCOUNT_ID, FILED],
    );
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });

    const row = (await rows<{ subject: string; from_addr: string }>(
      `SELECT subject, from_addr FROM messages WHERE message_id = '${gapId}'`,
    ))[0]!;
    // The update really landed, so this is not a skipped no-op...
    expect(row.subject).toBe('A thread with no sender address (edited)');
    // ...and the address a body taught the cache survived it, in the column and in the DTO.
    expect(row.from_addr).toBe('ann@example.invalid');
    expect((await filedList()).body.messages.find((one) => one.messageId === gapId)!.from)
      .toEqual({ name: 'Ann', address: 'ann@example.invalid' });
    expect((await searchFor('ann@example.invalid')).body.messages.map((one) => one.messageId))
      .toEqual([gapId]);
  }, 60_000);
});

describe('a delete that lands in the middle of a tick', () => {
  it('leaves no account row, no message rows and no FTS rows behind', async () => {
    marks().uidvalidity = 800;
    marks().messages.INBOX = [message(1, 'Mid tick'), message(2, 'Also mid tick')];
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });
    expect((await rows('SELECT rowid FROM messages')).length).toBeGreaterThan(0);

    // Park the next poll INSIDE the tick, so the delete runs while the tick is holding a page of
    // envelopes and is about to write account health.
    let release = () => undefined as void;
    marks().gate = new Promise<void>((resolve) => { release = () => resolve() });
    marks().messages.INBOX = [message(1, 'Mid tick'), message(2, 'Also mid tick'), message(3, 'Arrived late')];
    const tick = mailSyncForTesting()!.runTick({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const removed = await sendJson<{ ok: boolean }>('DELETE', `/accounts/${encodeURIComponent(ACCOUNT_ID)}`);
    expect([200, 202]).toContain(removed.status);
    release();
    marks().gate = null;
    await tick;

    // Nothing the tick did may bring the account back. A health write used to be an UPSERT, which
    // recreated the mirror with no provider config behind it, and the same tick's ingest reinserted
    // message rows that retention (which iterates accounts) could then never see again.
    expect(await rows('SELECT account_id FROM accounts')).toEqual([]);
    expect(await rows('SELECT rowid FROM messages')).toEqual([]);
    expect(await rows('SELECT rowid FROM messages_fts')).toEqual([]);
    expect(await rows('SELECT mailbox_id FROM mailboxes')).toEqual([]);
    expect(await bodyFiles()).toEqual([]);
    expect((await getJson<{ accounts: unknown[] }>('/accounts')).body.accounts).toEqual([]);
  }, 120_000);

  it('does not let a re-added account inherit the deleted one\'s auth park', async () => {
    // Park the account for real.
    const created = await sendJson<{ account: { accountId: string } }>('POST', '/accounts', {
      providerId: 'fake',
      values: { address: 'alice@example.invalid', password: 'app-password' },
    });
    expect(created.status).toBe(201);
    // Setup fires a poll of its own (fire and forget), and `runTick` queues behind it. Draining it
    // first is what makes the next tick the one that meets the auth failure.
    await mailSyncForTesting()!.runTick({ force: true });
    marks().failPollWith = 'auth';
    await mailSyncForTesting()!.runTick({ force: true });
    expect((await getJson<{ accounts: Array<{ state: string }> }>('/accounts')).body.accounts[0]!.state)
      .toBe('auth-required');

    await sendJson('DELETE', `/accounts/${encodeURIComponent(ACCOUNT_ID)}`);
    await sendJson('POST', '/accounts', {
      providerId: 'fake',
      values: { address: 'alice@example.invalid', password: 'the-fixed-password' },
    });

    // A fresh account with a working password must poll, not sit parked waiting for a human who
    // has already done the work. The loop's memory of the old account is what used to stop it.
    const pollsBefore = marks().polls.length;
    await mailSyncForTesting()!.runTick({});
    expect(marks().polls.length).toBeGreaterThan(pollsBefore);
    expect((await getJson<{ accounts: Array<{ state: string }> }>('/accounts')).body.accounts[0]!.state)
      .toBe('active');
  }, 120_000);
});

/*
 * Retention needs a different config, so it restarts the server. Everything above it needs the
 * first one, and the cache on disk survives the restart, which is the point.
 */
describe('retention', () => {
  it('deletes rows beyond the cap, with their body files and their FTS entries', async () => {
    // Give the newest three bodies something searchable, and make sure the doomed ones have a
    // body on disk so the sweep has files to clean up.
    marks().messages.INBOX = [
      message(1, 'Oldest', { text: 'the word blackcurrant is only here' }),
      message(2, 'Older'),
      message(3, 'Newer'),
      message(4, 'Newest'),
    ];
    marks().uidvalidity = 300;
    await sendJson('POST', '/refresh', { accountId: ACCOUNT_ID });
    await getJson(`/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent('INBOX:300:1')}`);

    expect((await rows('SELECT rowid FROM messages')).length).toBe(5);
    expect((await bodyFiles()).length).toBeGreaterThan(0);
    expect((await getJson<{ messages: unknown[] }>(
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=blackcurrant`,
    )).body.messages).toHaveLength(1);

    await stopServer();
    await boot({ poll_interval_seconds: 600, max_rows_per_account: 3, retention_days: 3650 });

    await mailSyncForTesting()!.runTick({ force: true });

    // Newest three kept, per ACCOUNT, whichever container they are in.
    const kept = await rows<{ message_id: string }>('SELECT message_id FROM messages ORDER BY sent_at DESC');
    expect(kept).toHaveLength(3);
    expect(kept.map((row) => row.message_id)).not.toContain('INBOX:300:1');

    // The body file went, and so did the FTS row: a contentless index that retention cannot
    // prune keeps answering for messages that no longer exist.
    expect((await getJson<{ messages: unknown[] }>(
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=blackcurrant`,
    )).body.messages).toEqual([]);
    const orphaned = await rows<{ rowid: number }>(
      'SELECT rowid FROM messages_fts WHERE rowid NOT IN (SELECT rowid FROM messages)',
    );
    expect(orphaned).toEqual([]);
  }, 180_000);
});

describe('deleting an account', () => {
  it('removes the mirror, the cache, the body files and tells the provider', async () => {
    events.length = 0;
    marks().removed.length = 0;
    const removed = await sendJson<{ ok: boolean; messages: number }>(
      'DELETE',
      `/accounts/${encodeURIComponent(ACCOUNT_ID)}`,
    );

    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);
    expect(marks().removed).toEqual([ACCOUNT_ID]);
    expect((await getJson<{ accounts: unknown[] }>('/accounts')).body.accounts).toEqual([]);
    expect(await rows('SELECT rowid FROM messages')).toEqual([]);
    expect(await rows('SELECT rowid FROM messages_fts')).toEqual([]);
    expect(await rows('SELECT mailbox_id FROM mailboxes')).toEqual([]);
    expect(await bodyFiles()).toEqual([]);
    expect(eventsOf('account-changed')).toEqual([{ accountId: ACCOUNT_ID, action: 'removed' }]);

    const gone = await sendJson<{ error: string }>('DELETE', `/accounts/${encodeURIComponent(ACCOUNT_ID)}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('unknown_account');
  }, 60_000);

  it('reports polling state on /health', async () => {
    const health = await getJson<Record<string, unknown>>('/health');
    expect(health.body).toMatchObject({ ok: true, accounts: 0, db: 'ready', polling: true, replica: false });
    expect(health.body.lastTickAt).toBeGreaterThan(0);
  });
});

/**
 * A replica polls NOTHING. Two boxes polling one mailbox double every fetch and every write, and
 * only the primary owns the outside account.
 *
 * Driven against the loop directly with a fake host rather than by booting a second server in
 * cloud mode: cloud mode changes the whole server's shape (bridge registry, relayed routes), so a
 * boot would be testing that instead of this one line.
 */
describe('on a replica', () => {
  it('arms no timer and polls nothing', async () => {
    const armed: number[] = [];
    const host = {
      replica: true,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      config: { get: async () => ({}), onChange: () => ({ dispose: () => undefined }) },
      timers: {
        interval: (_handler: () => unknown, ms: number) => { armed.push(ms); return { dispose: () => undefined } },
        timeout: (_handler: () => unknown, ms: number) => { armed.push(ms); return { dispose: () => undefined } },
      },
      notifications: { error: async () => undefined, recover: async () => undefined },
    } satisfies MailSyncHost;
    // Every dependency below throws if touched: the assertion is that NONE of them are.
    const explode = (what: string) => () => { throw new Error(`a replica must not touch ${what}`) };
    const sync = new MailSync({
      walnut: host,
      store: { listAccounts: explode('the cache') } as never,
      service: { provider: explode('a provider') } as never,
      retention: { retain: explode('the retention sweep') } as never,
      events: { syncCompleted: explode('the bus') } as never,
    });

    sync.start();
    expect(sync.polling).toBe(false);
    expect(armed).toEqual([]);

    // Both entry points step aside, including the human-driven one: a replica has no business
    // fetching from the account even when somebody clicks refresh on it.
    await expect(sync.runTick({ force: true })).resolves.toMatchObject({ polled: 0, added: 0 });
    await expect(sync.refresh(ACCOUNT_ID)).resolves.toMatchObject({ polled: 0 });
    sync.markDirty(ACCOUNT_ID, 'INBOX');
    expect(armed).toEqual([]);

    await sync.stop();
  });

  /**
   * And the ROUTES step aside too, all of them.
   *
   * A replica that answered a read from its own empty cache would show the user an empty mailbox
   * and look like data loss, and one that answered a write would poll or mutate an account it does
   * not own. Looped over the whole table on purpose: a route added later without the guard is the
   * failure this catches.
   */
  it('re-arms the interval when the poll interval changes', async () => {
    // A separate loop on a fake host, because what is graded is the TIMER and the real server's
    // timer is deliberately parked at 600s for the rest of this file.
    const armed: number[] = [];
    const disposed: number[] = [];
    let onConfigChange: (() => Promise<void> | void) | null = null;
    let interval = 120;
    const host = {
      replica: false,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      config: {
        get: async () => ({ poll_interval_seconds: interval }),
        onChange: (handler: () => Promise<void> | void) => { onConfigChange = handler; return { dispose: () => undefined } },
      },
      timers: {
        interval: (_handler: () => unknown, ms: number) => {
          const at = armed.push(ms) - 1;
          return { dispose: () => { disposed.push(at) } };
        },
        timeout: (_handler: () => unknown, ms: number) => ({ dispose: () => { void ms } }),
      },
      notifications: { error: async () => undefined, recover: async () => undefined },
    } satisfies MailSyncHost;
    const sync = new MailSync({
      walnut: host,
      store: { listAccounts: async () => [] } as never,
      service: {} as never,
      retention: {
        retain: async () => ({ messagesDeleted: 0, bodiesDropped: 0, incomplete: false }),
      } as never,
      events: {} as never,
    });

    sync.start();
    await expect.poll(() => armed.length, { timeout: 5_000 }).toBe(1);
    expect(armed[0]).toBe(120_000);

    // The interval is baked into the armed timer, so a new value means a new timer. Without this
    // the setting looked like it worked and changed nothing until the next server restart.
    interval = 30;
    await onConfigChange!();
    await expect.poll(() => armed.length, { timeout: 5_000 }).toBe(2);
    expect(armed[1]).toBe(30_000);
    expect(disposed).toEqual([0]);

    // An unrelated config change must NOT churn the timer: re-arming on every save would reset the
    // countdown every time the user touched any other mail setting.
    await onConfigChange!();
    expect(armed).toHaveLength(2);

    await sync.stop();
  });

  it('answers every route with 503 primary_only', async () => {
    const handlers: Array<{ method: string; path: string; handler: (request: unknown) => unknown }> = [];
    const walnut = {
      replica: true,
      pluginId: 'mail',
      log: { error: () => undefined, info: () => undefined, warn: () => undefined, debug: () => undefined },
      http: {
        route: (method: string, routePath: string, handler: (request: unknown) => unknown) => {
          handlers.push({ method, path: routePath, handler });
        },
      },
    };
    // Everything a handler could reach throws, so a route that forgets the guard fails loudly
    // rather than quietly answering from an empty replica cache.
    const explode = (what: string) => () => { throw new Error(`a replica route must not reach ${what}`) };
    registerMailRoutes(walnut as never, {
      store: { countOrNull: explode('the cache'), status: 'ready' } as never,
      service: { listAccounts: explode('the cache') } as never,
      accounts: { setup: explode('setup'), remove: explode('a purge') } as never,
      providers: { list: explode('the registry'), size: 0 } as never,
      sync: { refresh: explode('the poll loop'), polling: false, lastTick: 0 } as never,
      // The write path matters more here than the read path, not less: a replica that composed a
      // draft or minted an approval would be a SECOND box able to send the user's mail.
      drafts: {
        create: explode('a draft write'), get: explode('a draft read'), list: explode('a draft list'),
        patch: explode('a draft edit'), discard: explode('a draft discard'),
      } as never,
      approvals: {
        requestSend: explode('an approval letter'), consoleSend: explode('a send'),
        retry: explode('a retry'), withdrawFor: explode('a withdrawal'),
      } as never,
      sends: { list: explode('the send ledger'), require: explode('the send ledger') } as never,
      // The two exits mail has: one message becoming a task, and the day's unread becoming a
      // letter. A replica that took either would write the primary's tasks or send the human a
      // second copy of the same digest.
      messageTasks: { link: explode('the task ledger') } as never,
      digest: { sendNow: explode('the letter path') } as never,
    });

    expect(handlers.length).toBeGreaterThanOrEqual(20);
    for (const { method, path: routePath, handler } of handlers) {
      const answer = await handler({
        path: `/api/plugins/mail${routePath}`,
        query: {},
        json: async () => ({}),
      }) as { status?: number; json?: { error?: string } };
      expect(answer.status, `${method.toUpperCase()} ${routePath}`).toBe(503);
      expect(answer.json?.error, `${method.toUpperCase()} ${routePath}`).toBe('primary_only');
    }
  });
});
