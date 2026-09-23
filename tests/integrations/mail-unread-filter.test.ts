/**
 * "Only unread" answered by the DATABASE, over the whole mailbox rather than over the loaded page.
 *
 * The console's unread chip started life as a client-side pass over the fifty rows a page holds, so a
 * real mailbox showed "4 unread" under a folder row reading "Inbox 99+" and clicking it produced those
 * four. `GET /messages?unread=1` is the answer, and what is graded here is every way that filter can
 * be wrong:
 *
 * - It covers mail the caller has never loaded. The same mailbox, unfiltered, holds a small fraction
 *   of its unread mail on page one, and the filter finds all of it.
 * - It PAGES. `before` walks the unread set the same way it walks the full one, and `nextBefore` is
 *   still offered only when the page filled, so the end of the list ends.
 * - The flag is matched EXACTLY, as an element of the stored array: `\Seen` anywhere in the array
 *   means read, an empty array means unread, and a keyword that merely contains the word (`Seen`,
 *   `$Seen`) is not the flag and does not make a message read. A `LIKE '%\Seen%'` over the JSON text
 *   passes the first of those and fails the last one silently.
 * - The `seen` column and `flags_json` cannot drift: reading a message through the read route moves
 *   both, so the next unread page really has stopped returning it.
 * - The v7 backfill reads an EXISTING database, which is the only state a migration is ever wrong in.
 *
 * One assertion is about the plan rather than the answer (`messages_by_unread`), and it is here
 * because the column exists for that reason alone: an exact `json_each` predicate is correct and
 * unindexable, so it re-parses the flags of every row in the mailbox until the page fills.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-unread-filter-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import { MAIL_MIGRATIONS, mailDatabaseForTesting } from '../../src/integrations/mail/db.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { bus } from '../../src/core/event-bus.js';

const FIXTURE_ID = 'mail-unread-fixture';
const ACCOUNT_ID = 'fake:one';
const SEEN = '\\Seen';
const HOUR = 60 * 60 * 1000;

/** Newest first, so message index 0 is the top of the list and 119 the bottom. */
const TOTAL = 120;
const PAGE = 50;

/** The read flags this fixture hands out, cycled so `\Seen` appears in every position. */
const READ_SHAPES = [[SEEN], ['\\Answered', SEEN], ['\\Answered', '\\Flagged', SEEN]];

/**
 * Flags that merely CONTAIN the word: an IMAP keyword and a private one. Both are unread, and a
 * substring match on the stored JSON would call the message read.
 */
const NEAR_MISS = ['Seen', '$Seen'];

/** The message at this index carries `NEAR_MISS` instead of an empty array. It is still unread. */
const NEAR_MISS_INDEX = 3;

interface FixtureMessage {
  messageId: string;
  subject: string;
  sentAt: number;
  flags: string[];
}

interface Fixture {
  messages: FixtureMessage[];
  /**
   * The two flag operations, defined HERE rather than in the plugin source below.
   *
   * That source is a JS string inside a JS file, so a `\Seen` literal in it has to survive two rounds
   * of escaping, and getting the count wrong does not fail loudly: it silently matches nothing, which
   * would report the whole mailbox as unread and make this test pass for the wrong reason.
   */
  isSeen(flags: string[]): boolean;
  setSeen(flags: string[], read: boolean): string[];
  markRead: Array<[string, boolean]>;
  /**
   * What `listUnread` answers, when the test arms it: envelopes of the fixture's messages named
   * here, or a throw. Unarmed (undefined), the provider has no `listUnread` at all, which is the
   * shape every earlier case in this file was written against.
   */
  unreadFromProvider?: { messageIds: string[] } | { fail: string };
  /** Every `listUnread` call, so a test can say a later page did not ask again. */
  unreadCalls: Array<{ mailbox: string; limit: number }>;
  /** How long `listUnread` takes to answer. A real Outlook helper routinely takes seconds. */
  unreadDelayMs?: number;
}

let server: HttpServer;
let port = 0;

function marks(): Fixture {
  return (globalThis as unknown as { __mailUnread: Fixture }).__mailUnread;
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

interface Page {
  messages: Array<{ messageId: string; subject: string; flags: string[]; sentAt: number }>;
  nextBefore?: string;
}

/** One list request, with the query spelled out by the caller. */
function listPage(query: { limit?: number; unread?: string; before?: string } = {}): Promise<{ status: number; body: Page }> {
  const params = new URLSearchParams({ account: ACCOUNT_ID, mailbox: 'INBOX' });
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.unread !== undefined) params.set('unread', query.unread);
  if (query.before !== undefined) params.set('before', query.before);
  return getJson<Page>(`/messages?${params.toString()}`);
}

async function rows<T extends Record<string, unknown>>(sql: string, params?: unknown): Promise<T[]> {
  const db = mailDatabaseForTesting();
  expect(db, 'the mail plugin must have an open database').not.toBeNull();
  return db!.all<T>(sql, params);
}

/**
 * Write the folder badge the way a poll would have, without running a poll.
 *
 * The state under test is one only the real world produces: the badge carries the PROVIDER's own count
 * (every poll refreshes it) while the cached message rows are older than that. Running a real poll to set
 * it would re-ingest every message with its current flags and correct the cache by the poll, which is the
 * very path being tested around.
 */
async function setFolderBadge(unread: number): Promise<void> {
  const db = mailDatabaseForTesting();
  expect(db, 'the mail plugin must have an open database').not.toBeNull();
  await db!.run('UPDATE mailboxes SET unread = ? WHERE mailbox_id = ?', [unread, 'INBOX']);
}

/**
 * Put the CACHE in a known unread state: the newest `count` rows unread, every other row read.
 *
 * Written straight to the rows rather than through a poll, for the same reason `setFolderBadge` is: the
 * state under test is a cache that disagrees with the provider, and a poll would resolve the
 * disagreement before the case could look at it. The cases in this block share one database, so a case
 * that cares about counts has to establish them rather than inherit them.
 */
async function cacheUnread(count: number): Promise<string[]> {
  const db = mailDatabaseForTesting();
  expect(db, 'the mail plugin must have an open database').not.toBeNull();
  const all = await db!.all<{ message_id: string }>(
    'SELECT message_id FROM messages ORDER BY sent_at DESC',
  );
  const wanted = all.slice(0, count).map((row) => row.message_id);
  await db!.run("UPDATE messages SET seen = 1, flags_json = '[\"\\\\Seen\"]'");
  for (const id of wanted) {
    await db!.run("UPDATE messages SET seen = 0, flags_json = '[]' WHERE message_id = ?", [id]);
  }
  return wanted
}

/**
 * The mailbox: 120 messages, 37 of them unread, spread so the unread set outruns a page.
 *
 * `index % 3 === 0` up to 108 puts 17 unread on the first page of fifty, 17 on the second and 3 on
 * the third, which is exactly the shape the old client-side filter got wrong.
 */
function isUnreadIndex(index: number): boolean {
  return index % 3 === 0 && index <= 108;
}

function buildMessages(): FixtureMessage[] {
  const base = Date.UTC(2026, 4, 1, 9, 0, 0);
  const out: FixtureMessage[] = [];
  let readShape = 0;
  for (let index = 0; index < TOTAL; index += 1) {
    const unread = isUnreadIndex(index);
    const flags = unread
      ? (index === NEAR_MISS_INDEX ? [...NEAR_MISS] : [])
      : [...READ_SHAPES[readShape++ % READ_SHAPES.length]!];
    out.push({
      messageId: `INBOX:1:${1000 - index}`,
      subject: `Harbour note ${index}`,
      sentAt: base - index * HOUR,
      flags,
    });
  }
  return out;
}

function unreadSubjects(): string[] {
  const fixture = marks();
  return fixture.messages.filter((one) => !fixture.isSeen(one.flags)).map((one) => one.subject);
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
          // Every tick in this file is driven by the account being added, so a background timer
          // cannot land between an action and its assertion. The row cap is well above the 120
          // messages here, or retention would evict the tail this test pages into.
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

/** The provider plugin, attached the documented way: a manifest that depends on the mail base. */
async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Unread Fixture',
    description: 'An in-memory mailbox whose read flags the test controls',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  // No flag literal in this source at all: the test owns `isSeen`, so nobody has to count
  // backslashes across a JS literal inside a JS literal.
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const S = () => globalThis.__mailUnread;

function findMessage(messageId) {
  return S().messages.find((one) => one.messageId === messageId) ?? null;
}

function envelope(one, mailbox) {
  return {
    messageId: one.messageId,
    rfcMessageId: '<' + one.messageId.replace(/:/g, '-') + '@example.invalid>',
    mailboxId: mailbox,
    from: { name: 'Alice', address: 'alice@example.invalid' },
    to: [{ address: 'me@example.invalid' }],
    subject: one.subject,
    snippet: one.subject + '.',
    sentAt: one.sentAt,
    sentAtHeader: new Date(one.sentAt).toUTCString(),
    flags: [...one.flags],
    attachments: [],
    bodyBytes: 32,
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
      submit: async (values) => ({
        accountId: '${ACCOUNT_ID}',
        providerId: 'fake',
        displayName: 'Fixture mailbox',
        address: values.address,
        state: 'active',
      }),
    },
    listAccounts: async () => [{
      accountId: '${ACCOUNT_ID}', providerId: 'fake', displayName: 'Fixture mailbox',
      address: 'alice@example.invalid', state: 'active',
    }],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [{
      mailboxId: 'INBOX',
      name: 'Inbox',
      role: 'inbox',
      total: S().messages.length,
      unread: S().messages.filter((one) => !S().isSeen(one.flags)).length,
    }],
    poll: async (accountId, request) => ({
      messages: S().messages.map((one) => envelope(one, request.mailbox)),
      cursor: request.mailbox + ':1:end',
      more: false,
    }),
    // Present only when the test arms it, so the cases written before 1.9.0 see the old shape.
    ...(S().unreadFromProvider ? {
      listUnread: async (accountId, mailbox, limit) => {
        S().unreadCalls.push({ mailbox, limit });
        if (S().unreadDelayMs) await new Promise((resolve) => setTimeout(resolve, S().unreadDelayMs));
        const armed = S().unreadFromProvider;
        if ('fail' in armed) throw new Error(armed.fail);
        return armed.messageIds.map((id) => envelope(findMessage(id), mailbox));
      },
    } : {}),
    getBody: async (accountId, messageId) => {
      const message = findMessage(messageId);
      if (!message) {
        const error = new Error('no such message: ' + messageId);
        error.code = 'not-found';
        throw error;
      }
      const text = message.subject + ' body.';
      return { format: 'text', text, bytes: Buffer.byteLength(text) };
    },
    markRead: async (accountId, messageId, read) => {
      const message = findMessage(messageId);
      if (!message) {
        const error = new Error('no such message: ' + messageId);
        error.code = 'not-found';
        throw error;
      }
      S().markRead.push([messageId, read]);
      // The read flag is SERVER state: a later poll has to agree with what the console just did,
      // or the next sync would put the message back on the unread list.
      message.flags = S().setSeen(message.flags, read);
    },
    send: async () => { throw new Error('the fixture does not send'); },
    removeAccount: async () => undefined,
  });
  return { dispose: () => handle.dispose() };
}
`);
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  (globalThis as unknown as { __mailUnread: Fixture }).__mailUnread = {
    messages: buildMessages(),
    isSeen: (flags: string[]) => flags.includes(SEEN),
    setSeen: (flags: string[], read: boolean) => {
      const without = flags.filter((flag) => flag !== SEEN);
      return read ? [...without, SEEN] : without;
    },
    markRead: [],
    unreadCalls: [],
  };
  await writeFixtureProvider();
  await writeConfig();
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  const created = await sendJson<{ account: { accountId: string } }>('POST', '/accounts', {
    providerId: 'fake',
    values: { address: 'alice@example.invalid' },
  });
  expect(created.status).toBe(201);
  // The first sync is kicked by the account being added; the whole mailbox has to be in the cache
  // before anything below can page it. A hand-rolled wait because `expect.poll` only works inside a
  // test, and seeding here is what lets every case below start from the same mailbox.
  await waitForCachedRows(TOTAL, 60_000);
}, 180_000);

/** Wait for the first sync to land, and say what it got to if it does not. */
async function waitForCachedRows(count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let held = -1;
  while (Date.now() < deadline) {
    const db = mailDatabaseForTesting();
    if (db) held = (await db.all('SELECT rowid FROM messages').catch(() => [])).length;
    if (held === count) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`the fixture mailbox did not reach ${count} cached rows (last saw ${held})`);
}

afterAll(async () => {
  await stopServer();
  delete (globalThis as unknown as { __mailUnread?: Fixture }).__mailUnread;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

describe('the fixture mailbox', () => {
  it('holds 120 messages with 37 unread, spread past the first page', () => {
    expect(marks().messages).toHaveLength(TOTAL);
    expect(unreadSubjects()).toHaveLength(37);
    const onFirstPage = marks().messages.slice(0, PAGE).filter((one) => !marks().isSeen(one.flags));
    expect(onFirstPage).toHaveLength(17);
  });
});

describe('unread=1 is the whole mailbox, not the loaded page', () => {
  it('answers with every unread message where the unfiltered page holds seventeen of them', async () => {
    const plain = await listPage({ limit: PAGE });
    expect(plain.status).toBe(200);
    expect(plain.body.messages).toHaveLength(PAGE);
    // THE BUG, stated as a number: a client filtering this answer can only ever find these.
    expect(plain.body.messages.filter((one) => !one.flags.includes(SEEN))).toHaveLength(17);

    const filtered = await listPage({ limit: PAGE, unread: '1' });
    expect(filtered.status).toBe(200);
    expect(filtered.body.messages.map((one) => one.subject)).toEqual(unreadSubjects());
    expect(filtered.body.messages).toHaveLength(37);
    expect(filtered.body.messages.every((one) => !one.flags.includes(SEEN))).toBe(true);
    // Newest first, exactly as the unfiltered list is ordered.
    expect(filtered.body.messages[0]!.subject).toBe('Harbour note 0');
    // Thirty-seven under a limit of fifty is a SHORT page, so there is no cursor: a console that got
    // one would ask for an empty page every time it reached the end of the unread list.
    expect(filtered.body.nextBefore).toBeUndefined();
  });

  it('pages the unread set with before, offering a cursor only on the page that filled', async () => {
    const first = await listPage({ limit: 25, unread: '1' });
    expect(first.body.messages).toHaveLength(25);
    expect(typeof first.body.nextBefore).toBe('string');

    const second = await listPage({ limit: 25, unread: '1', before: first.body.nextBefore! });
    expect(second.body.messages).toHaveLength(12);
    expect(second.body.nextBefore).toBeUndefined();

    // The two pages are the unread set exactly: nothing repeated, nothing skipped, still in order.
    const walked = [...first.body.messages, ...second.body.messages].map((one) => one.subject);
    expect(walked).toEqual(unreadSubjects());
    expect(new Set(walked).size).toBe(37);
  });

  it('reads the flag as an array element, so position, emptiness and near misses all come out right', async () => {
    const filtered = await listPage({ limit: PAGE, unread: '1' });
    const listed = new Map(filtered.body.messages.map((one) => [one.subject, one.flags]));

    // `\Seen` last in the array is still read. A cursor over the JSON text would get this right too;
    // the next assertion is the one that separates them.
    const seenLast = marks().messages.find((one) => one.flags[one.flags.length - 1] === SEEN
      && one.flags.length === 3)!;
    expect(seenLast.flags).toEqual(['\\Answered', '\\Flagged', SEEN]);
    expect(listed.has(seenLast.subject)).toBe(false);

    // A keyword that CONTAINS the word is not the flag. `LIKE '%\Seen%'` calls this message read and
    // drops it from a list the person is using to find mail they have not read.
    const nearMiss = marks().messages[NEAR_MISS_INDEX]!;
    expect(nearMiss.flags).toEqual(NEAR_MISS);
    expect(listed.get(nearMiss.subject)).toEqual(NEAR_MISS);

    // An empty array is unread: IMAP states the positive, so absence is what "not read" looks like.
    const empty = marks().messages.find((one) => one.flags.length === 0)!;
    expect(listed.get(empty.subject)).toEqual([]);

    // And every `\Seen` shape the fixture hands out is absent, whichever slot the flag sits in.
    for (const shape of READ_SHAPES) {
      const read = marks().messages.find((one) => one.flags.join(',') === shape.join(','));
      expect(read, `a message with flags ${shape.join(',')}`).toBeDefined();
      expect(listed.has(read!.subject)).toBe(false);
    }
  });

  it('treats unread=0, an unrecognised value and no parameter as the same unfiltered request', async () => {
    const absent = await listPage({ limit: 10 });
    for (const value of ['0', 'false', '', 'yes']) {
      const answer = await listPage({ limit: 10, unread: value });
      expect(answer.status, `unread=${value}`).toBe(200);
      expect(answer.body.messages.map((one) => one.subject), `unread=${value}`)
        .toEqual(absent.body.messages.map((one) => one.subject));
    }
    // Ten rows of the whole mailbox, so this really is the unfiltered list and not a short answer.
    expect(absent.body.messages.map((one) => one.subject)).toEqual(
      marks().messages.slice(0, 10).map((one) => one.subject),
    );
  });

  it('uses the unread index rather than scanning the mailbox', async () => {
    const plan = await rows<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT rowid FROM messages WHERE account_id = ? AND mailbox_id = ?'
      + ' AND seen = 0 ORDER BY sent_at DESC, message_id DESC LIMIT ?',
      [ACCOUNT_ID, 'INBOX', PAGE],
    );
    const detail = plan.map((one) => one.detail).join(' | ');
    expect(detail, 'the seen column exists to be indexed; without this it is just a scan')
      .toContain('messages_by_unread');
    expect(detail).not.toContain('SCAN messages');
  });
});

describe('reading a message leaves the unread set', () => {
  it('drops out of the next unread page, and the column agrees with the flags array', async () => {
    const before = await listPage({ limit: PAGE, unread: '1' });
    const target = before.body.messages[0]!;

    const read = await sendJson<{ ok: boolean; message: { flags: string[] } }>(
      'POST',
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(target.messageId)}/read`,
      { read: true },
    );
    expect(read.status).toBe(200);
    expect(read.body.message.flags).toContain(SEEN);
    expect(marks().markRead).toEqual([[target.messageId, true]]);

    // The stored column moved with the array. Nothing else in the plugin can keep those two in step,
    // and a `seen` that lags its own flags is a message that is unread on one screen and read on the
    // next.
    const stored = await rows<{ seen: number; flags_json: string }>(
      'SELECT seen, flags_json FROM messages WHERE account_id = ? AND message_id = ?',
      [ACCOUNT_ID, target.messageId],
    );
    expect(stored[0]!.seen).toBe(1);
    expect(JSON.parse(stored[0]!.flags_json) as string[]).toContain(SEEN);

    const after = await listPage({ limit: PAGE, unread: '1' });
    expect(after.body.messages.map((one) => one.messageId)).not.toContain(target.messageId);
    expect(after.body.messages).toHaveLength(36);
    // It is still in the mailbox, which is the difference between a filter and a delete.
    const plain = await listPage({ limit: PAGE });
    expect(plain.body.messages.map((one) => one.messageId)).toContain(target.messageId);
  });

  it('comes back when the same route marks it unread again', async () => {
    const plain = await listPage({ limit: 1 });
    const target = plain.body.messages[0]!;
    expect(target.flags).toContain(SEEN);

    const back = await sendJson<{ message: { flags: string[] } }>(
      'POST',
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(target.messageId)}/read`,
      { read: false },
    );
    expect(back.status).toBe(200);
    expect(back.body.message.flags).not.toContain(SEEN);

    const stored = await rows<{ seen: number }>(
      'SELECT seen FROM messages WHERE account_id = ? AND message_id = ?',
      [ACCOUNT_ID, target.messageId],
    );
    expect(stored[0]!.seen).toBe(0);

    const filtered = await listPage({ limit: PAGE, unread: '1' });
    expect(filtered.body.messages.map((one) => one.messageId)).toContain(target.messageId);
    expect(filtered.body.messages).toHaveLength(37);
  });
});

/**
 * The v7 backfill, on a database that already holds rows.
 *
 * A fresh install proves nothing about a migration: every existing mail cache reaches v7 with flags
 * already written, and the column starts at its DEFAULT of 0, which reads as "everything is unread".
 * So this migrates to v6, writes the flag shapes a real cache holds, and then migrates the rest of the
 * way through the plugin's own migration list rather than a copy of it.
 */
describe('the v7 migration', () => {
  it('fills seen from flags_json on an existing v6 database', async () => {
    const file = path.join(WALNUT_HOME, 'migration-probe', 'plugin.sqlite');
    const client = new PluginDatabaseClient(file);
    try {
      await client.migrate(MAIL_MIGRATIONS.filter((one) => one.version <= 6));
      const columnsAtV6 = await client.all<{ name: string }>('PRAGMA table_info(messages)');
      expect(columnsAtV6.map((row) => row.name)).not.toContain('seen');

      const cases: Array<[string, string | null]> = [
        ['read-only-flag', JSON.stringify([SEEN])],
        ['read-flag-first', JSON.stringify([SEEN, '\\Answered'])],
        ['read-flag-last', JSON.stringify(['\\Answered', '\\Flagged', SEEN])],
        ['unread-empty-array', '[]'],
        ['unread-other-flags', JSON.stringify(['\\Flagged'])],
        ['unread-near-miss', JSON.stringify(NEAR_MISS)],
        // Rows a real cache can hold: `flags_json` has been nullable since v1, and a value that is
        // not JSON would make `json_each` raise and take the whole migration with it.
        ['unread-null-flags', null],
        ['unread-malformed-flags', 'not json at all'],
      ];
      for (const [messageId, flagsJson] of cases) {
        await client.run(
          'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr,'
          + ' subject, snippet, sent_at, flags_json, attachments_json, updated_at, envelope_hash)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            'a:1', messageId, `<${messageId}@example.invalid>`, 'INBOX', 'alice@example.invalid',
            messageId, '', 1_700_000_000_000, flagsJson, '[]', 0, `hash-${messageId}`,
          ],
        );
      }

      // The version the whole list reaches, read from the list rather than written down: this test is
      // about the v7 BACKFILL, and pinning a literal here makes every later migration fail a test that
      // has nothing to say about it.
      const latest = MAIL_MIGRATIONS[MAIL_MIGRATIONS.length - 1]!.version;
      expect(await client.migrate(MAIL_MIGRATIONS)).toBe(latest);

      const backfilled = await client.all<{ message_id: string; seen: number }>(
        'SELECT message_id, seen FROM messages ORDER BY message_id',
      );
      expect(backfilled.map((row) => `${row.message_id}=${row.seen}`)).toEqual([
        'read-flag-first=1',
        'read-flag-last=1',
        'read-only-flag=1',
        'unread-empty-array=0',
        'unread-malformed-flags=0',
        'unread-near-miss=0',
        'unread-null-flags=0',
        'unread-other-flags=0',
      ]);

      // And the index the column exists for arrived with it.
      const indexes = await client.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'",
      );
      expect(indexes.map((row) => row.name)).toContain('messages_by_unread');

      // Migrating again is a no-op rather than a second ALTER, which would throw.
      expect(await client.migrate(MAIL_MIGRATIONS)).toBe(latest);
    } finally {
      await client.dispose();
    }
  }, 60_000);
});

/**
 * The provider's own unread list (contract 1.9.0). Last in the file on purpose: it re-registers
 * the provider plugin with `listUnread` armed and changes the fixture mailbox, and every case above
 * was written against the poll-only shape.
 */
describe('the unread filter asks the provider first', () => {
  async function rearm(armed: Fixture['unreadFromProvider']): Promise<void> {
    marks().unreadFromProvider = armed;
    marks().unreadCalls = [];
    const reloaded = await fetch(`http://127.0.0.1:${port}/api/plugin-runtime/${FIXTURE_ID}/reload`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(reloaded.status).toBe(200);
  }

  it('ingests what the server says is unread before reading the cache, and only on the first page', async () => {
    const fixture = marks();
    // Two things the cache cannot know without a poll: a cached message marked unread on another
    // device, and a brand-new unread message no poll has delivered yet.
    const flipped = fixture.messages[1]!;
    flipped.flags = fixture.setSeen(flipped.flags, false);
    const fresh: FixtureMessage = {
      messageId: 'INBOX:1:2000', subject: 'Harbour note fresh', sentAt: Date.UTC(2026, 4, 2, 9, 0, 0), flags: [],
    };
    fixture.messages.unshift(fresh);
    // The answer names EVERY unread message, because that is what `listUnread` means: "what is unread
    // right now". Arming only the two interesting ids would be a provider claiming the rest are read,
    // and the refresh believes a complete answer (see the reconcile cases below).
    await rearm({
      messageIds: fixture.messages.filter((one) => !fixture.isSeen(one.flags)).map((one) => one.messageId),
    });

    const before = await rows<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE seen = 0");
    const first = await listPage({ limit: PAGE, unread: '1' });
    expect(first.status).toBe(200);
    const subjects = first.body.messages.map((one) => one.subject);
    expect(subjects[0]).toBe('Harbour note fresh');
    expect(subjects).toContain(flipped.subject);
    expect(first.body.messages).toHaveLength(before[0]!.n + 2);
    expect(marks().unreadCalls).toEqual([{ mailbox: 'INBOX', limit: PAGE }]);
    // The cache now agrees, so the plain list shows the fresh message too.
    const plain = await listPage({ limit: 5 });
    expect(plain.body.messages[0]!.subject).toBe('Harbour note fresh');

    // A LATER page pages the corrected cache; the provider is not asked again.
    const paged = await listPage({ limit: 10, unread: '1' });
    expect(paged.body.nextBefore).toBeTruthy();
    await listPage({ limit: 10, unread: '1', before: paged.body.nextBefore });
    expect(marks().unreadCalls).toHaveLength(2);
    expect(marks().unreadCalls.every((call) => call.mailbox === 'INBOX')).toBe(true);
  });

  it('answers from the cache when the provider cannot say, without an error', async () => {
    await rearm({ fail: 'the mail server is asleep' });
    const cached = await rows<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE seen = 0");

    const page = await listPage({ limit: PAGE, unread: '1' });

    expect(page.status).toBe(200);
    expect(page.body.messages).toHaveLength(cached[0]!.n);
    expect(marks().unreadCalls).toHaveLength(1);
  });

  /**
   * Read somewhere else, and the cache has no way to hear about it — until this.
   *
   * The ingest half of the refresh can only ADD: a message read on a phone LEAVES the provider's unread
   * answer, and an absence writes nothing. On a provider whose poll walks newest-first down to a
   * watermark, nothing else can correct it either, because a conversation already below the line is
   * never listed again. Measured on a real account on 2026-09-21: the folder badge said 4 unread and the
   * console listed 12, eight of them read hours earlier.
   */
  it('marks read what a complete answer did not name, and pages without them', async () => {
    const fixture = marks();
    const unread = fixture.messages.filter((one) => !fixture.isSeen(one.flags));
    expect(unread.length).toBeGreaterThan(3);
    const stillUnread = [unread[0]!, unread[1]!];
    // The state being simulated, in FULL: the human read the rest on their phone, so the server now holds
    // two unread messages and says so in both places it can be asked. Arming only the list would be a
    // provider whose folder still counts 37 while its unread list names 2, and that disagreement is
    // exactly what the reconcile treats as an incomplete answer (see the badge cases below): a page of an
    // answer is not permission to mark the rest of the mailbox read.
    const keep = new Set(stillUnread.map((one) => one.messageId));
    for (const message of unread) {
      if (!keep.has(message.messageId)) message.flags = fixture.setSeen(message.flags, true);
    }
    await setFolderBadge(stillUnread.length);
    await rearm({ messageIds: stillUnread.map((one) => one.messageId) });

    const page = await listPage({ limit: PAGE, unread: '1' });

    expect(page.status).toBe(200);
    expect(page.body.messages.map((one) => one.subject).sort())
      .toEqual(stillUnread.map((one) => one.subject).sort());
    // The DATABASE agrees, so the next page and the folder's own count do too.
    const left = await rows<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE seen = 0');
    expect(left[0]!.n).toBe(2);
    // And the flags array moved with the column: a row cleared this way really carries `\Seen`.
    const cleared = await rows<{ flags_json: string | null }>(
      'SELECT flags_json FROM messages WHERE message_id = ?', [unread[2]!.messageId],
    );
    expect(JSON.parse(cleared[0]!.flags_json ?? '[]')).toContain(SEEN);
  });

  /**
   * A CAPPED answer proves less, and the difference matters: a page-sized limit on a mailbox with more
   * unread mail than that would otherwise mark the whole tail read.
   */
  it('concludes nothing below the oldest entry of an answer that filled its limit', async () => {
    const fixture = marks();
    // Three unread in the cache, one of them OLD: a complete answer establishes them.
    const newest = fixture.messages.slice(0, 2);
    const oldest = fixture.messages[fixture.messages.length - 1]!;
    // The envelopes this provider hands back carry the fixture's own flags, so a message it is asked to
    // report as unread has to actually BE unread on its side.
    for (const one of [...newest, oldest]) one.flags = fixture.setSeen(one.flags, false);
    await rearm({ messageIds: [...newest, oldest].map((one) => one.messageId) });
    await listPage({ limit: PAGE, unread: '1' });
    expect((await rows<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE seen = 0'))[0]!.n).toBe(3);

    // Now an answer that FILLS its limit, naming only the two newest. It is a prefix, not the set, so
    // the old one it never reached must keep its unread flag.
    await rearm({ messageIds: newest.map((one) => one.messageId) });
    const page = await listPage({ limit: 2, unread: '1' });

    expect(page.status).toBe(200);
    const still = await rows<{ seen: number }>(
      'SELECT seen FROM messages WHERE message_id = ?', [oldest.messageId],
    );
    expect(still[0]!.seen, 'a capped answer proves nothing about mail older than its tail').toBe(0);
  });

  /**
   * The provider contract's most dangerous sentence, end to end: "an empty array means nothing to add,
   * NEVER nothing is unread". A provider is allowed to answer `[]` for a folder it cannot filter, and a
   * real one does (the Outlook provider answers the unread question for the Inbox only). Believing it
   * marks a whole folder read on the strength of a provider declining to answer, and a mail wrongly
   * marked read is hidden rather than merely shown as stale.
   */
  it('leaves the cache alone when the answer names nothing but the folder still counts unread', async () => {
    const cached = await cacheUnread(5);
    await setFolderBadge(cached.length);
    await rearm({ messageIds: [] });

    const page = await listPage({ limit: PAGE, unread: '1' });

    expect(page.status).toBe(200);
    expect(marks().unreadCalls).toHaveLength(1);
    expect(page.body.messages).toHaveLength(cached.length);
    const after = await rows<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE seen = 0');
    expect(after[0]!.n, 'an answer that named nothing must not empty the folder').toBe(cached.length);
  });

  /** And the one case where nothing named really does mean nothing unread: the folder says so too. */
  it('clears the cache when the answer names nothing and the folder agrees it is clear', async () => {
    await cacheUnread(5);
    await setFolderBadge(0);
    await rearm({ messageIds: [] });

    const page = await listPage({ limit: PAGE, unread: '1' });

    expect(page.status).toBe(200);
    expect(page.body.messages).toHaveLength(0);
    const after = await rows<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE seen = 0');
    expect(after[0]!.n).toBe(0);
  });
});

/**
 * The console has to HEAR about a correction that lands after its page did (2026-09-23).
 *
 * A smart list ("All Inboxes") waits only a moment for the provider and then answers from the cache,
 * leaving the unread call to run on. A real Outlook helper routinely takes seconds, so the page on
 * screen kept showing mail read on a phone while the cache under it had already been corrected: the
 * reported "I already read these, why are they still here". `unread-reconciled` is how the open page
 * learns to read again, and it must be said only when rows were actually cleared.
 */
describe('a late unread correction is announced', () => {
  const EVENT = 'plugin:mail:unread-reconciled';

  async function rearm(armed: Fixture['unreadFromProvider'], delayMs = 0): Promise<void> {
    marks().unreadFromProvider = armed;
    marks().unreadCalls = [];
    marks().unreadDelayMs = delayMs;
    const reloaded = await fetch(`http://127.0.0.1:${port}/api/plugin-runtime/${FIXTURE_ID}/reload`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(reloaded.status).toBe(200);
  }

  /** Every `unread-reconciled` the bus carries while `body` runs. */
  async function recording<T>(body: (seen: unknown[]) => Promise<T>): Promise<T> {
    const seen: unknown[] = [];
    const name = `mail-unread-probe-${Math.random().toString(36).slice(2)}`;
    bus.subscribe(name, (event) => { if (event.name === EVENT) seen.push(event.data); }, { global: true });
    try { return await body(seen); } finally { bus.unsubscribe(name); }
  }

  /** Make the provider's side agree with `stillUnread` and nothing else: read everywhere but these. */
  function readEverywhereBut(stillUnread: string[]): void {
    const fixture = marks();
    const keep = new Set(stillUnread);
    for (const one of fixture.messages) one.flags = fixture.setSeen(one.flags, !keep.has(one.messageId));
  }

  function scopePage(): Promise<{ status: number; body: Page }> {
    return getJson<Page>(`/messages?${new URLSearchParams({ scope: 'role:inbox', unread: '1', limit: String(PAGE) })}`);
  }

  it('tells the console when a smart list\'s correction outlives the page that asked for it', async () => {
    const cached = await cacheUnread(6);
    const stillUnread = cached.slice(0, 2);
    readEverywhereBut(stillUnread);
    await setFolderBadge(stillUnread.length);
    // Slower than the smart list is willing to wait, which is the production shape.
    await rearm({ messageIds: stillUnread }, 2_500);

    await recording(async (seen) => {
      const first = await scopePage();
      expect(first.status).toBe(200);
      // The precondition of the bug: the page was answered from the cache before the provider did.
      expect(first.body.messages, 'the page answers before a slow provider does').toHaveLength(6);
      expect(seen, 'nothing has been corrected yet').toEqual([]);

      await expect.poll(() => seen.length, { timeout: 15_000, interval: 100 }).toBe(1);
      expect(seen[0]).toEqual({ accountId: ACCOUNT_ID, mailboxId: 'INBOX', cleared: 4 });

      // What the console does on hearing it: read the page again, and it is right this time.
      const again = await scopePage();
      expect(again.body.messages.map((one) => one.messageId).sort()).toEqual([...stillUnread].sort());
      // And that re-read asks nobody: the correction it follows is what made the folder agree.
      expect(marks().unreadCalls, 'the re-read must not buy a second provider call').toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen, 'one correction is one event, and the re-read causes none').toHaveLength(1);
    });
  }, 30_000);

  it('says nothing when the refresh had nothing to clear', async () => {
    const cached = await cacheUnread(3);
    readEverywhereBut(cached);
    await setFolderBadge(cached.length);
    await rearm({ messageIds: cached });

    await recording(async (seen) => {
      const page = await listPage({ limit: PAGE, unread: '1' });
      expect(page.status).toBe(200);
      expect(page.body.messages).toHaveLength(3);
      expect(marks().unreadCalls).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen, 'a refresh that agreed with the cache is not news').toEqual([]);
    });
  });

  it('says nothing, and changes nothing, when the provider cannot answer', async () => {
    await cacheUnread(4);
    await setFolderBadge(1);
    await rearm({ fail: 'the helper stopped' });

    await recording(async (seen) => {
      const page = await listPage({ limit: PAGE, unread: '1' });
      expect(page.status).toBe(200);
      expect(page.body.messages, 'a failed refresh leaves the cache as it was').toHaveLength(4);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen).toEqual([]);
    });
  });
});
