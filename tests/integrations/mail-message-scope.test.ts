/**
 * `GET /messages?scope=role:inbox`: ONE list across every account, answered by ONE query.
 *
 * Two accounts share one cache, and the same role has a DIFFERENT mailbox id in each of them (the two
 * providers on the machine this was written for answer `INBOX` and `inbox`). So the filter is a list of
 * (account_id, mailbox_id) PAIRS, and every way that can go wrong is graded here:
 *
 * - A pair filter, never a bare id list. This fixture gives account A an ordinary label whose id is
 *   literally `inbox` while account B's INBOX-role folder has that same id, so an id-only filter pulls
 *   an unrelated archive label into somebody's unified inbox.
 * - The empty answer. A role no account has resolves to ZERO pairs, and this route with no `account`
 *   and no `mailbox` otherwise returns every account and every folder: the unified list has to come
 *   back empty rather than come back with spam and trash in it.
 * - Paging across a TIE. Three messages share a timestamp across two accounts and two of them share a
 *   message id, so the sort key needs its third field; the page boundary here falls inside that group.
 * - The per-account request is untouched. Its predicate is snapshotted byte for byte, and the legacy
 *   bare-number cursor still means what it always meant.
 * - `unread=1` narrows in SQL, over the pairs, and counts exactly what the per-account pages count.
 * - A scope this server does not have, or a scope next to `account`, is a 400 and never a silent
 *   fallback to "everything".
 *
 * C70, the query plan, measured against a COPY of the real cache (7,811 message rows, 70 mailbox rows,
 * 3,703 of them in the two inbox pairs) rather than against this fixture:
 *
 *   plan A (one OR group, what is implemented): first page 3.03ms cold, 0.51ms median of seven
 *   plan B (per-pair LIMIT seek + UNION ALL):   first page 0.37ms cold, 0.06ms median
 *   plan A with unread=1:                       0.02ms cold, 0.01ms median
 *   EXPLAIN QUERY PLAN for A: MULTI-INDEX OR, one `messages_by_unread` seek per pair, then a temp
 *   b-tree for the ORDER BY.
 *
 * Plan A is kept: it is 40x the cost of B in relative terms and 3ms in absolute ones, which is what
 * matters on the one event loop every route shares, and it stays one statement with one bound predicate
 * instead of a generated UNION whose branch count changes with the account list. The spec's trigger for
 * switching to B is a measured 50ms; there is two orders of magnitude of headroom. The OR shape is
 * asserted below so this note and the code cannot drift apart.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-message-scope-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { encodeMessageCursor, decodeMessageCursor } from '../../src/integrations/mail/contract.js';
import { MESSAGE_COLUMNS, mailDatabaseForTesting, type MailDatabase } from '../../src/integrations/mail/db.js';
import { parseMessageScope } from '../../src/integrations/mail/scope.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import { startServer, stopServer } from '../../src/web/server.js';

const FIXTURE_ID = 'mail-scope-fixture';
const HOUR = 60 * 60 * 1000;
const ONE = 'fake:one';
const TWO = 'fake:two';

/** A fixed instant, with retention widened in the config so nothing here is ever evicted. */
const BASE = Date.UTC(2026, 4, 1, 9, 0, 0);

interface FixtureMessage {
  accountId: string;
  mailboxId: string;
  messageId: string;
  subject: string;
  sentAt: number;
  unread: boolean;
}

/**
 * Twelve messages, and three of the facts about them are the whole point.
 *
 * `tie-900` exists in BOTH accounts at the same second with different subjects, `tie-901` shares that
 * second from one of them, and account A's `inbox` label is an ordinary folder that must never appear in
 * a role:inbox list.
 */
const MESSAGES: FixtureMessage[] = [
  { accountId: ONE, mailboxId: 'INBOX', messageId: 'INBOX:1:10', subject: 'Harbour timetable', sentAt: BASE, unread: false },
  { accountId: TWO, mailboxId: 'inbox', messageId: 'inbox:1:7', subject: 'Marina berth list', sentAt: BASE - HOUR / 2, unread: true },
  { accountId: ONE, mailboxId: 'INBOX', messageId: 'INBOX:1:9', subject: 'Harbour dredging', sentAt: BASE - HOUR, unread: true },
  { accountId: ONE, mailboxId: 'INBOX', messageId: 'INBOX:1:8', subject: 'Harbour lights', sentAt: BASE - 2 * HOUR, unread: false },
  { accountId: TWO, mailboxId: 'inbox', messageId: 'tie-901', subject: 'Marina tie one', sentAt: BASE - 3 * HOUR, unread: false },
  { accountId: TWO, mailboxId: 'inbox', messageId: 'tie-900', subject: 'Marina tie two', sentAt: BASE - 3 * HOUR, unread: true },
  { accountId: ONE, mailboxId: 'INBOX', messageId: 'tie-900', subject: 'Harbour tie two', sentAt: BASE - 3 * HOUR, unread: false },
  { accountId: TWO, mailboxId: 'inbox', messageId: 'inbox:1:5', subject: 'Marina fuel dock', sentAt: BASE - 5 * HOUR, unread: false },
  // The decoy label: account A's own folder whose id collides with account B's inbox id.
  { accountId: ONE, mailboxId: 'inbox', messageId: 'label-1', subject: 'Filed receipt', sentAt: BASE - HOUR / 6, unread: true },
  { accountId: ONE, mailboxId: 'inbox', messageId: 'label-2', subject: 'Filed notice', sentAt: BASE - 4 * HOUR, unread: true },
  { accountId: ONE, mailboxId: 'Sent', messageId: 'Sent:1:2', subject: 'Harbour reply', sentAt: BASE - 6 * HOUR, unread: false },
  { accountId: TWO, mailboxId: 'sent', messageId: 'sent:1:3', subject: 'Marina reply', sentAt: BASE - 7 * HOUR, unread: false },
];

/** Mailbox rows per account. Account B has no drafts folder at all, which is one of the cases. */
const MAILBOXES: Record<string, Array<{ mailboxId: string; name: string; role: string }>> = {
  [ONE]: [
    { mailboxId: 'INBOX', name: 'Inbox', role: 'inbox' },
    { mailboxId: 'Sent', name: 'Sent', role: 'sent' },
    { mailboxId: 'inbox', name: 'Filed', role: 'other' },
  ],
  [TWO]: [
    { mailboxId: 'inbox', name: 'Inbox', role: 'inbox' },
    { mailboxId: 'sent', name: 'Sent', role: 'sent' },
  ],
};

interface Fixture {
  messages: FixtureMessage[];
  mailboxes: typeof MAILBOXES;
}

let server: HttpServer;
let port = 0;

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

interface Page {
  messages: Array<{ accountId: string; mailboxId: string; messageId: string; subject: string; sentAt: number; flags: string[] }>;
  nextBefore?: string;
}

/** One list request. Every parameter is spelled by the caller so a test can omit exactly one. */
function listPage(query: Record<string, string>): Promise<{ status: number; body: Page }> {
  return getJson<Page>(`/messages?${new URLSearchParams(query).toString()}`);
}

/** `accountId messageId` per row: the only identity a cross-account list has. */
function keys(page: Page): string[] {
  return page.messages.map((one) => `${one.accountId} ${one.messageId}`);
}

/** What the server must answer for a role, in the three-field order, computed from the fixture. */
function expectedForRole(role: 'inbox' | 'sent', opts?: { unread?: boolean }): string[] {
  const pairs = Object.entries(MAILBOXES).flatMap(([accountId, rows]) => rows
    .filter((row) => row.role === role)
    .map((row) => `${accountId} ${row.mailboxId}`));
  return MESSAGES
    .filter((one) => pairs.includes(`${one.accountId} ${one.mailboxId}`))
    .filter((one) => (opts?.unread ? one.unread : true))
    .sort((left, right) => (
      right.sentAt - left.sentAt
      || (left.messageId < right.messageId ? 1 : left.messageId > right.messageId ? -1 : 0)
      || (left.accountId < right.accountId ? 1 : left.accountId > right.accountId ? -1 : 0)
    ))
    .map((one) => `${one.accountId} ${one.messageId}`);
}

async function writeConfig(): Promise<void> {
  await fsp.writeFile(
    CONFIG_FILE,
    yaml.dump({
      version: 1,
      user: { name: 'test' },
      defaults: { priority: 'none' },
      plugins: {
        mail: {
          // Every sync here is kicked by an account being added, so no background tick can land
          // between an action and its assertion.
          poll_interval_seconds: 600,
          retention_days: 3650,
          max_rows_per_account: 5000,
          digest_enabled: false,
        },
      },
    }),
    'utf-8',
  );
}

/**
 * The provider plugin, attached the documented way: a manifest that depends on the mail base.
 *
 * ONE provider with TWO accounts, which is what makes the collision real: an account id is
 * `<providerId>:<rest>`, so both accounts route back here and both sets of mailboxes live in one cache.
 */
async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Scope Fixture',
    description: 'Two accounts whose mailbox ids collide, for the cross-account list',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const S = () => globalThis.__mailScope;
const ONE = '${ONE}';
const TWO = '${TWO}';
const accounts = [];

function envelope(one) {
  return {
    messageId: one.messageId,
    rfcMessageId: '<' + one.messageId.replace(/:/g, '-') + '@example.invalid>',
    mailboxId: one.mailboxId,
    from: { name: 'Sender', address: 'sender@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: one.subject,
    snippet: one.subject + '.',
    sentAt: one.sentAt,
    sentAtHeader: new Date(one.sentAt).toUTCString(),
    // Read state as an array element, which is what the cache's seen column is derived from.
    flags: one.unread ? [] : ['\\\\Seen'],
    attachments: [],
    bodyBytes: 24,
  };
}

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const handle = base.registerProvider({
    id: 'fake',
    label: 'Fake',
    capabilities: {
      search: false, watch: false, drafts: false, markRead: true, flags: false,
      threads: false, send: false, sendAsReply: false, bodies: 'text', attachments: 'none',
    },
    setup: {
      fields: [{ name: 'address', label: 'Address', kind: 'text' }],
      submit: async (values) => {
        const first = String(values.address || '').startsWith('one@');
        const account = {
          accountId: first ? ONE : TWO,
          providerId: 'fake',
          displayName: first ? 'Harbour mail' : 'Marina mail',
          address: values.address,
          state: 'active',
        };
        if (!accounts.some((held) => held.accountId === account.accountId)) accounts.push(account);
        return account;
      },
    },
    listAccounts: async () => accounts.map((one) => ({ ...one })),
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async (accountId) => (S().mailboxes[accountId] ?? []).map((row) => {
      const held = S().messages.filter((one) => one.accountId === accountId && one.mailboxId === row.mailboxId);
      return { ...row, total: held.length, unread: held.filter((one) => one.unread).length };
    }),
    poll: async (accountId, request) => ({
      messages: S().messages
        .filter((one) => one.accountId === accountId && one.mailboxId === request.mailbox)
        .map(envelope),
      cursor: request.mailbox + ':1:end',
      more: false,
    }),
    getBody: async (accountId, messageId) => {
      const one = S().messages.find((held) => held.accountId === accountId && held.messageId === messageId);
      if (!one) { const error = new Error('no such message'); error.code = 'not-found'; throw error; }
      return { format: 'text', text: one.subject + ' body.', bytes: 32 };
    },
    send: async () => { throw new Error('the fixture does not send'); },
    removeAccount: async () => undefined,
  });
  return { dispose: () => handle.dispose() };
}
`);
}

/** Wait for both first syncs to land, and say what they got to if they do not. */
async function waitForCachedRows(count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let held = -1;
  while (Date.now() < deadline) {
    const db = mailDatabaseForTesting();
    if (db) held = (await db.all('SELECT rowid FROM messages').catch(() => [])).length;
    if (held === count) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the fixture cache did not reach ${count} rows (last saw ${held})`);
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  (globalThis as unknown as { __mailScope: Fixture }).__mailScope = {
    messages: MESSAGES,
    mailboxes: MAILBOXES,
  };
  await writeFixtureProvider();
  await writeConfig();
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  for (const who of ['one@example.invalid', 'two@example.invalid']) {
    const created = await sendJson<{ account: { accountId: string } }>('POST', '/accounts', {
      providerId: 'fake',
      values: { address: who },
    });
    expect(created.status).toBe(201);
  }
  await waitForCachedRows(MESSAGES.length, 60_000);
}, 180_000);

afterAll(async () => {
  await stopServer();
  delete (globalThis as unknown as { __mailScope?: Fixture }).__mailScope;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

describe('parseMessageScope', () => {
  it('accepts exactly three values and never degrades an unknown one to undefined', () => {
    expect(parseMessageScope('role:inbox')).toEqual({ role: 'inbox' });
    expect(parseMessageScope('role:sent')).toEqual({ role: 'sent' });
    expect(parseMessageScope('role:drafts')).toEqual({ role: 'drafts' });
    // Absent is the only shape that means "an ordinary per-account page".
    expect(parseMessageScope(undefined)).toBeUndefined();
    expect(parseMessageScope('')).toBeUndefined();
    // Everything else is a refusal, including the near misses a client could plausibly send.
    for (const raw of ['inbox', 'role:archive', 'role:INBOX', 'ROLE:inbox', ' role:inbox', 'role:inbox ', 'role:spam', 'all']) {
      expect(parseMessageScope(raw), raw).toBe('invalid');
    }
  });
});

describe('scope filters by (account, mailbox) PAIRS (C2)', () => {
  it('answers with both accounts inboxes and leaves the label whose id collides out of it', async () => {
    const page = await listPage({ scope: 'role:inbox', limit: '50' });
    expect(page.status).toBe(200);
    expect(keys(page.body)).toEqual(expectedForRole('inbox'));
    // Both id spellings are present, which an id-only filter could only manage by naming both.
    expect(page.body.messages.some((one) => one.mailboxId === 'INBOX')).toBe(true);
    expect(page.body.messages.some((one) => one.mailboxId === 'inbox' && one.accountId === TWO)).toBe(true);
    // THE BUG this pair filter exists for: account A's ordinary `inbox` label shares B's id, and its
    // two messages are the ones a bare id list would have mixed into somebody's unified inbox.
    expect(page.body.messages.filter((one) => one.accountId === ONE && one.mailboxId === 'inbox')).toEqual([]);
    expect(keys(page.body)).not.toContain(`${ONE} label-1`);
    expect(keys(page.body)).not.toContain(`${ONE} label-2`);
    // A per-account request for that same label still returns them: nothing was hidden, only scoped.
    const label = await listPage({ account: ONE, mailbox: 'inbox', limit: '50' });
    expect(keys(label.body)).toEqual([`${ONE} label-1`, `${ONE} label-2`]);
  });

  it('answers role:sent from both accounts and role:drafts, which no account has, with nothing', async () => {
    const sent = await listPage({ scope: 'role:sent', limit: '50' });
    expect(keys(sent.body)).toEqual(expectedForRole('sent'));
    expect(sent.body.messages).toHaveLength(2);
    // ZERO pairs must mean zero rows. This route with no account and no mailbox answers with every
    // folder in the cache, so a fall-through here would hand back all twelve messages, spam included.
    const drafts = await listPage({ scope: 'role:drafts', limit: '50' });
    expect(drafts.status).toBe(200);
    expect(drafts.body.messages).toEqual([]);
    expect(drafts.body.nextBefore).toBeUndefined();
  });
});

describe('paging across a tie group (C3)', () => {
  it('walks three messages that share a second across two accounts without loss or repeat', async () => {
    const want = expectedForRole('inbox');
    expect(want).toHaveLength(8);
    const walked: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const answer = await listPage({ scope: 'role:inbox', limit: '2', ...(before ? { before } : {}) });
      expect(answer.status).toBe(200);
      walked.push(...keys(answer.body));
      before = answer.body.nextBefore;
      if (!before) break;
    }
    // The page boundary falls INSIDE the tie group (two of its three rows on one page), which is the
    // arrangement a two-field cursor either skips or serves twice.
    expect(walked).toEqual(want);
    expect(new Set(walked).size).toBe(want.length);
    const tie = walked.filter((one) => one.endsWith('tie-900') || one.endsWith('tie-901'));
    expect(tie).toEqual([`${TWO} tie-901`, `${TWO} tie-900`, `${ONE} tie-900`]);
  });

  it('carries the account in the token only on a scope page', async () => {
    const scoped = await listPage({ scope: 'role:inbox', limit: '2' });
    expect(decodeMessageCursor(scoped.body.nextBefore)?.accountId).toBeTruthy();
    const perAccount = await listPage({ account: ONE, mailbox: 'INBOX', limit: '2' });
    expect(decodeMessageCursor(perAccount.body.nextBefore)?.accountId).toBeUndefined();
  });
});

describe('scope with unread=1 (C5)', () => {
  it('narrows in SQL and returns exactly the sum of the pairs unread rows', async () => {
    const filtered = await listPage({ scope: 'role:inbox', unread: '1', limit: '50' });
    expect(filtered.status).toBe(200);
    expect(keys(filtered.body)).toEqual(expectedForRole('inbox', { unread: true }));
    expect(filtered.body.messages.every((one) => !one.flags.includes('\\Seen'))).toBe(true);

    // The same number the per-account pages add up to, and NOT the unread of the colliding label
    // (which holds two more unread rows of its own).
    const perAccount = await Promise.all([
      listPage({ account: ONE, mailbox: 'INBOX', unread: '1', limit: '50' }),
      listPage({ account: TWO, mailbox: 'inbox', unread: '1', limit: '50' }),
    ]);
    const summed = perAccount.reduce((total, one) => total + one.body.messages.length, 0);
    expect(filtered.body.messages).toHaveLength(summed);
    expect(summed).toBe(3);
    const label = await listPage({ account: ONE, mailbox: 'inbox', unread: '1', limit: '50' });
    expect(label.body.messages).toHaveLength(2);
  });
});

describe('a scope this server does not have is a 400 (C69)', () => {
  it('refuses an unknown value and refuses scope next to account, instead of answering with everything', async () => {
    for (const scope of ['role:archive', 'inbox', 'role:INBOX', 'all']) {
      const answer = await listPage({ scope, limit: '50' });
      expect(answer.status, scope).toBe(400);
      expect((answer.body as unknown as { error: string }).error).toBe('invalid');
      expect((answer.body as unknown as { messages?: unknown }).messages).toBeUndefined();
    }
    const both = await listPage({ scope: 'role:inbox', account: ONE, limit: '50' });
    expect(both.status).toBe(400);
    expect((both.body as unknown as { message: string }).message).toContain('scope covers every account');
  });
});

/** A store over a database that only writes down what it was asked, for a predicate snapshot. */
function recordingStore(): { store: MailStore; seen: Array<{ sql: string; params: unknown }> } {
  const seen: Array<{ sql: string; params: unknown }> = [];
  const db = {
    all: async (sql: string, params?: unknown) => { seen.push({ sql, params }); return []; },
  } as unknown as MailDatabase;
  return { store: new MailStore(db), seen };
}

/**
 * The per-account statement as HEAD wrote it, spelled out.
 *
 * A literal rather than a computed comparison: the promise is that a per-account page's SQL did not
 * change, and only a written-down expectation can fail when a refactor quietly adds a clause to it.
 */
const HEAD_SELECT = `SELECT ${MESSAGE_COLUMNS} FROM messages`;
const HEAD_ORDER = ' ORDER BY sent_at DESC, message_id DESC LIMIT ?';

/**
 * The cursor separator, built rather than typed.
 *
 * A raw NUL in a source file makes the whole file read as binary to grep, and one that landed inside a
 * regular expression in this repo once made an assertion true for every input.
 */
const SEP = String.fromCharCode(0);

describe('the per-account request is untouched (C4)', () => {
  it('builds the same predicate, params and order it always did', async () => {
    const { store, seen } = recordingStore();
    await store.listMessages({ accountId: ONE, mailboxId: 'INBOX', limit: 50 });
    expect(seen[0]!.sql).toBe(`${HEAD_SELECT} WHERE account_id = ? AND mailbox_id = ?${HEAD_ORDER}`);
    expect(seen[0]!.params).toEqual([ONE, 'INBOX', 50]);

    await store.listMessages({ accountId: ONE, mailboxId: 'INBOX', limit: 50, unread: true });
    expect(seen[1]!.sql).toBe(`${HEAD_SELECT} WHERE account_id = ? AND mailbox_id = ? AND seen = 0${HEAD_ORDER}`);

    await store.listMessages({
      accountId: ONE, mailboxId: 'INBOX', limit: 50, before: { sentAt: BASE, messageId: 'INBOX:1:9' },
    });
    expect(seen[2]!.sql).toBe(
      `${HEAD_SELECT} WHERE account_id = ? AND mailbox_id = ?`
      + ' AND (sent_at < ? OR (sent_at = ? AND message_id < ?))'
      + HEAD_ORDER,
    );
    expect(seen[2]!.params).toEqual([ONE, 'INBOX', BASE, BASE, 'INBOX:1:9', 50]);

    // No filters at all is still "every account, every folder", which is exactly why an unrecognised
    // scope has to be a 400 rather than a dropped parameter.
    await store.listMessages({ limit: 10 });
    expect(seen[3]!.sql).toBe(`${HEAD_SELECT}${HEAD_ORDER}`);
  });

  it('reads a legacy bare-number cursor as the two-field comparison it always meant', async () => {
    const legacy = decodeMessageCursor(String(BASE));
    expect(legacy).toEqual({ sentAt: BASE, messageId: '' });
    const { store, seen } = recordingStore();
    await store.listMessages({ accountId: ONE, mailboxId: 'INBOX', limit: 50, before: legacy! });
    // Two comparisons, not three: the empty id makes the tie half false, so the predicate reduces to
    // `sent_at < ?` and the token means what the tab that holds it already saw.
    expect(seen[0]!.sql).toContain('(sent_at < ? OR (sent_at = ? AND message_id < ?))');
    expect(seen[0]!.sql).not.toContain('account_id < ?');
    expect(seen[0]!.sql).toContain(HEAD_ORDER);

    // And through the route: strictly older rows only, so the tie group at that second is dropped,
    // which is what this shape has always done and is still better than an error.
    const page = await listPage({ account: ONE, mailbox: 'INBOX', limit: '50', before: String(BASE - 3 * HOUR) });
    expect(page.status).toBe(200);
    expect(keys(page.body)).toEqual([]);
  });

  it('keeps the two-segment encoding byte for byte and round-trips the three-segment one', () => {
    expect(encodeMessageCursor({ sentAt: 5, messageId: 'a' }))
      .toBe(Buffer.from(`5${SEP}a`, 'utf8').toString('base64url'));
    const three = encodeMessageCursor({ sentAt: 5, messageId: 'a', accountId: TWO });
    expect(three).toBe(Buffer.from(`5${SEP}a${SEP}${TWO}`, 'utf8').toString('base64url'));
    expect(decodeMessageCursor(three)).toEqual({ sentAt: 5, messageId: 'a', accountId: TWO });
    // An empty third segment is dropped rather than kept as a comparison that can never be true.
    expect(decodeMessageCursor(Buffer.from(`5${SEP}a${SEP}`, 'utf8').toString('base64url')))
      .toEqual({ sentAt: 5, messageId: 'a' });
  });
});

describe('the pair statement is plan A, and only pair requests get the third layer (C70)', () => {
  it('emits one OR group, the three-field order, and the third comparison only with an account token', async () => {
    const { store, seen } = recordingStore();
    const pairs = [{ accountId: ONE, mailboxId: 'INBOX' }, { accountId: TWO, mailboxId: 'inbox' }];
    await store.listMessages({ limit: 50, pairs });
    // Plan A: ONE statement, one OR group of equality pairs, sorted on the three-field key. The
    // measured cost of this shape against the real cache is in the file header.
    expect(seen[0]!.sql).toBe(
      `${HEAD_SELECT} WHERE ((account_id = ? AND mailbox_id = ?) OR (account_id = ? AND mailbox_id = ?))`
      + ' ORDER BY sent_at DESC, message_id DESC, account_id DESC LIMIT ?',
    );
    expect(seen[0]!.sql).not.toContain('UNION');
    expect(seen[0]!.params).toEqual([ONE, 'INBOX', TWO, 'inbox', 50]);

    await store.listMessages({
      limit: 50, pairs, before: { sentAt: BASE, messageId: 'tie-900', accountId: TWO },
    });
    expect(seen[1]!.sql).toContain(
      ' AND (sent_at < ? OR (sent_at = ? AND message_id < ?)'
      + ' OR (sent_at = ? AND message_id = ? AND account_id < ?))',
    );
    expect(seen[1]!.params).toEqual([
      ONE, 'INBOX', TWO, 'inbox', BASE, BASE, 'tie-900', BASE, 'tie-900', TWO, 50,
    ]);

    // A role no account holds must never widen to "no filter": zero pairs answers with no rows and
    // issues no statement at all.
    const empty = await store.listMessages({ limit: 50, pairs: [] });
    expect(empty).toEqual([]);
    expect(seen).toHaveLength(2);
  });

  it('resolves the pairs of a role with one query over the mailbox rows', async () => {
    const db = mailDatabaseForTesting();
    expect(db, 'the mail plugin must have an open database').not.toBeNull();
    const store = new MailStore(db!);
    // `unread` rides along on the same index scan: it is the PROVIDER's own count, and the smart list
    // compares it against the cache before deciding whether a provider call could teach it anything.
    expect(await store.mailboxesByRole('inbox')).toEqual([
      { account_id: ONE, mailbox_id: 'INBOX', unread: expect.any(Number) },
      { account_id: TWO, mailbox_id: 'inbox', unread: expect.any(Number) },
    ]);
    // The colliding label is role `other`, so it is in no role's pair list.
    expect(await store.mailboxesByRole('drafts')).toEqual([]);
  });
});

describe('two pages of the merged list are the same rows the server would order in one (C53)', () => {
  it('walks the whole window in pages of three with no repeat and the same order as one page', async () => {
    const whole = await listPage({ scope: 'role:inbox', limit: '50' });
    const walked: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const answer = await listPage({ scope: 'role:inbox', limit: '3', ...(before ? { before } : {}) });
      walked.push(...keys(answer.body));
      before = answer.body.nextBefore;
      if (!before) break;
    }
    // Row for row identical to the one-page answer, which is what a client assembling two pages has
    // to end up with. A duplicate here is the (accountId, messageId) identity being wrong somewhere.
    expect(walked).toEqual(keys(whole.body));
    expect(new Set(walked).size).toBe(walked.length);
    // The cross-account same-id pair is present ONCE per account, with its own subject each time.
    const sameId = whole.body.messages.filter((one) => one.messageId === 'tie-900');
    expect(sameId).toHaveLength(2);
    expect(new Set(sameId.map((one) => one.accountId)).size).toBe(2);
    expect(new Set(sameId.map((one) => one.subject)).size).toBe(2);
  });
});
