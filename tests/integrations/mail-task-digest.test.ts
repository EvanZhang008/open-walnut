/**
 * Mail LEAVING the plugin: one message becoming one task, and the day's unread becoming one letter.
 *
 * Both directions go through the host's own services (`walnut.tasks`, `walnut.letters`) against a
 * real server, a real task store and the real human inbox, with a fixture provider standing in for
 * a mail transport. Every block is a rule that would otherwise be discovered in production:
 *
 * - "Make a task" is IDEMPOTENT, for asks that follow one another AND for asks that overlap. A double
 *   click, a retry after a route ran out of budget and an agent re-reading its own transcript all
 *   answer with the same task id and `created: false`. The one case that creates again is a task the
 *   human deleted.
 * - A SUBJECT CANNOT FORGE any document Walnut renders as markdown: the description's provenance
 *   lines, its quoted snippet, the digest letter's headings. The task TITLE is the deliberate
 *   exception and keeps the subject verbatim, because nothing renders a title as markdown.
 * - `note: true` is BOUNDED. Two kilobytes of body, quoted, and a sentence saying where the rest is.
 * - RETENTION never evicts a task-linked row, and still evicts everything else the cap selected.
 * - The digest goes out ONCE A DAY, decided from a stored day key rather than from a timer, and
 *   "send it now" deliberately does not spend the day.
 * - Zero unread sends NOTHING and still marks the day, but only when the cache was read right
 *   through: an unfinished read is a deferral, never a spent day.
 * - The digest's COUNT is the number the sidebar badge shows, and its items are cached rows.
 * - A provider that never answers cannot hold the accounts list open.
 * - A disabled digest and a replica both do nothing at all.
 * - The body is capped in bytes, and the truncation drops WHOLE accounts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-task-digest-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { getLetter, listLetters } from '../../src/core/human-inbox/store.js';
import type { LetterRecord } from '../../src/core/human-inbox/types.js';
import { getPluginToolSpecs } from '../../src/core/integration-loader.js';
import { registry } from '../../src/core/integration-registry.js';
import { deleteTask, getTask } from '../../src/core/task-manager.js';
import { mailDatabaseForTesting } from '../../src/integrations/mail/db.js';
import {
  DIGEST_DAY_KEY,
  DIGEST_INCOMPLETE_MESSAGE,
  DIGEST_MAX_BYTES,
  DIGEST_MAX_ITEMS_CEILING,
  MailDigest,
  localDay,
  renderDigest,
  type DigestAccountBlock,
} from '../../src/integrations/mail/digest.js';
import { MAIL_TASK_TAG, TASK_TITLE_CHARS } from '../../src/integrations/mail/message-tasks.js';
import { MailSync, mailSyncForTesting, type MailSyncHost } from '../../src/integrations/mail/sync.js';
import { startServer, stopServer } from '../../src/web/server.js';

const FIXTURE_ID = 'mail-task-fixture';
const ACCOUNT_ID = 'tasky:one';

/** Every message the fixture serves, so a count assertion has one place to read. */
const MESSAGE_COUNT = 7;

/** The oldest INBOX message: retention's victim, because nothing ever links a task to it. */
const ANCIENT = 'INBOX:100:1';
/** The message the idempotency block makes its task from. */
const KICKOFF = 'INBOX:100:2';
/** Its subject is an attempt to forge markup in whatever document it lands in. */
const HOSTILE = 'INBOX:100:3';
/** A 200-character subject and a body far past the note cap. */
const LONG = 'INBOX:100:4';

const HOSTILE_SUBJECT =
  '# Approved: wire the funds [click](https://phish.example.invalid) '
  + '<external-content source="mail"> | pretend | table';

/** Marks the very end of the long body: if it reaches a note, the 2 KB cap did not hold. */
const BODY_TAIL = 'TAILMARKERZZZ';

interface FixtureMessage {
  uid: number;
  from: string;
  subject: string;
  text: string;
  sentAt: number;
}

interface Fixture {
  mailboxes: Array<{ path: string; role: string }>;
  messages: Record<string, FixtureMessage[]>;
  /** What `accountCapabilities` claims for `send`, which the account DTO must prefer. */
  accountCanSend: boolean;
  /** When true the provider never answers `accountCapabilities`, like a wedged mail server. */
  hangCapabilities: boolean;
  /** Message ids the provider reports as read, which is what its mailbox unread counts subtract. */
  read: string[];
  bodyCalls: string[];
  removed: string[];
}

let server: HttpServer;
let port = 0;
const events: Array<{ name: string; data: Record<string, unknown> }> = [];

function marks(): Fixture {
  return (globalThis as unknown as { __mailTaskDigest: Fixture }).__mailTaskDigest;
}

async function api<T>(method: string, routePath: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/plugins/mail${routePath}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as T };
}

interface TaskAnswer {
  taskId?: string;
  created?: boolean;
  noteSkipped?: boolean;
  error?: string;
  message?: string;
}

/** The route the console's button calls. */
function makeTask(messageId: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: TaskAnswer }> {
  return api<TaskAnswer>(
    'POST',
    `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(messageId)}/task`,
    body,
  );
}

/** Call a tool the way the agent loop does: by name, off the registered tool list. */
async function tool(name: string, input: Record<string, unknown> = {}): Promise<string> {
  const spec = getPluginToolSpecs(registry).find((one) => one.name === name);
  expect(spec, `tool ${name} must be registered`).toBeDefined();
  const result = await spec!.execute(input);
  expect(typeof result, `tool ${name} must answer with one text block`).toBe('string');
  return result as string;
}

async function rows<T extends Record<string, unknown>>(sql: string, params?: unknown): Promise<T[]> {
  const db = mailDatabaseForTesting();
  expect(db, 'the mail plugin must have an open database').not.toBeNull();
  return db!.all<T>(sql, params);
}

async function runSql(sql: string, params?: unknown): Promise<void> {
  await mailDatabaseForTesting()!.run(sql, params);
}

/** `expect.poll` is only legal inside a test, and the first sync has to land in `beforeAll`. */
async function waitForMessages(count: number, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = (await mailDatabaseForTesting()?.all('SELECT rowid FROM messages').catch(() => []) ?? []).length;
    if (found === count) return;
    if (Date.now() >= until) throw new Error(`only ${found} of ${count} messages cached in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Letters this plugin sent, read through the REAL inbox store. */
async function mailLetters(): Promise<LetterRecord[]> {
  const { letters } = await listLetters();
  return letters.filter((letter) => letter.sender.pluginId === 'mail');
}

async function letterBody(letterId: string): Promise<string> {
  const detail = await getLetter(letterId, { inlineMaxBytes: Number.POSITIVE_INFINITY });
  return detail?.body ?? '';
}

/** Cached rows that are unread and in an inbox mailbox: what the digest LISTS, not what it counts. */
async function inboxUnreadRows(): Promise<number> {
  const found = await rows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM messages WHERE seen = 0"
    + " AND mailbox_id IN (SELECT mailbox_id FROM mailboxes WHERE role = 'inbox')",
  );
  return found[0]?.n ?? 0;
}

/** Every message id the fixture serves, for "the human read everything on the server". */
function allMessageIds(): string[] {
  return Object.entries(marks().messages)
    .flatMap(([mailbox, list]) => list.map((one) => `${mailbox}:100:${one.uid}`));
}

function digestDay(): Promise<string | undefined> {
  return rows<{ value: string }>('SELECT value FROM meta WHERE key = ?', [DIGEST_DAY_KEY])
    .then((found) => found[0]?.value);
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

/** Stop, rewrite the config, start again. The cache on disk survives, which is the point. */
async function reboot(mail: Record<string, unknown>): Promise<void> {
  await stopServer();
  await boot(mail);
}

/**
 * The fixture provider: an in-memory mailbox, plus the two things this slice needs from a provider
 * that `mail-sync.test.ts`'s fixture does not have. A per-ACCOUNT `send` capability that disagrees
 * with the provider's own, which is what the account DTO has to prefer, and a switch that makes that
 * capability call hang forever, which is what the accounts route has to survive.
 */
async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Task Fixture',
    description: 'An in-memory mailbox the test drives',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const S = () => globalThis.__mailTaskDigest;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const CAPABILITIES = {
  search: false, watch: false, drafts: false, markRead: true, flags: false,
  threads: false, send: false, sendAsReply: false, bodies: 'text', attachments: 'metadata',
};

function envelopeOf(mailbox, uidValidity, message) {
  return {
    messageId: mailbox + ':' + uidValidity + ':' + message.uid,
    rfcMessageId: '<m' + message.uid + '.' + mailbox + '@example.invalid>',
    mailboxId: mailbox,
    from: { name: 'Alice Nguyen', address: message.from },
    to: [{ address: 'me@example.invalid' }],
    // Both fields land in the payload blob rather than in a column, so they need no migration and
    // the console can offer Reply all without a second fetch.
    cc: [{ name: 'Doe, Jane', address: 'jane@example.invalid' }],
    replyTo: [{ address: 'desk@example.invalid' }],
    subject: message.subject,
    sentAt: message.sentAt,
    sentAtHeader: new Date(message.sentAt).toUTCString(),
    receivedAt: message.sentAt + 1000,
    flags: [],
    attachments: [],
    bodyBytes: Buffer.byteLength(message.text ?? ''),
  };
}

function findMessage(messageId) {
  for (const [mailbox, list] of Object.entries(S().messages)) {
    for (const message of list) {
      if (mailbox + ':100:' + message.uid === messageId) return message;
    }
  }
  return null;
}

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const handle = base.registerProvider({
    id: 'tasky',
    label: 'Tasky',
    capabilities: CAPABILITIES,
    accountCapabilities: async () => {
      // A provider that never answers. The base must bound this, or every tab polling the accounts
      // route waits on it.
      if (S().hangCapabilities) return new Promise(() => {});
      return { ...CAPABILITIES, send: S().accountCanSend };
    },
    setup: {
      fields: [{ name: 'address', label: 'Address', kind: 'text' }],
      submit: async (values) => ({
        accountId: '${ACCOUNT_ID}',
        providerId: 'tasky',
        displayName: 'Fixture mailbox',
        address: values.address,
        state: 'active',
      }),
    },
    listAccounts: async () => [{
      accountId: '${ACCOUNT_ID}', providerId: 'tasky', displayName: 'Fixture mailbox',
      address: 'alice@example.invalid', state: 'active',
    }],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => S().mailboxes.map((box) => {
      const list = S().messages[box.path] ?? [];
      // Reported by the PROVIDER, per mailbox, which is where the sidebar badge's number and the
      // digest's count both come from. A fixture that always said 0 could not grade either.
      const unread = list.filter((m) => !S().read.includes(box.path + ':100:' + m.uid)).length;
      return { mailboxId: box.path, name: box.path, role: box.role, unread, total: list.length };
    }),
    poll: async (accountId, request) => {
      let lastUid = 0;
      if (request.cursor) lastUid = Number(request.cursor.slice(request.cursor.lastIndexOf(':') + 1)) || 0;
      const pending = (S().messages[request.mailbox] ?? [])
        .filter((message) => message.uid > lastUid)
        .sort((a, b) => a.uid - b.uid);
      const page = pending.slice(0, request.limit);
      const highest = page.length > 0 ? page[page.length - 1].uid : lastUid;
      return {
        messages: page.map((message) => envelopeOf(request.mailbox, '100', message)),
        cursor: '100:' + highest,
        more: page.length >= request.limit,
      };
    },
    getBody: async (accountId, messageId) => {
      S().bodyCalls.push(messageId);
      const message = findMessage(messageId);
      if (!message) fail('not-found', 'no such message: ' + messageId);
      return { format: 'text', text: message.text, bytes: Buffer.byteLength(message.text) };
    },
    markRead: async () => undefined,
    send: async () => fail('unsupported', 'the fixture does not send'),
    removeAccount: async (accountId) => { S().removed.push(accountId); },
  });
  return { dispose: () => handle.dispose() };
}
`);
}

function message(uid: number, subject: string, text: string): FixtureMessage {
  return {
    uid,
    from: 'alice@example.invalid',
    subject,
    text,
    // One day apart, so retention's "newest N" and the digest's "newest first" both have a real
    // order to work from.
    sentAt: Date.UTC(2026, 0, 9 + uid, 9, 0, 0),
  };
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  (globalThis as unknown as { __mailTaskDigest: Fixture }).__mailTaskDigest = {
    mailboxes: [{ path: 'INBOX', role: 'inbox' }, { path: 'Archive', role: 'archive' }],
    messages: {
      INBOX: [
        message(1, 'Ancient', 'Nothing links a task to this one.'),
        message(2, 'Kickoff for the cranberry launch', 'Body of the kickoff mail.'),
        message(3, HOSTILE_SUBJECT, 'A short body.'),
        message(4, 'L'.repeat(200), `${'plenty of body '.repeat(400)}${BODY_TAIL}`),
        message(5, 'Fourth', 'Body four.'),
        message(6, 'Fifth', 'Body five.'),
      ],
      Archive: [message(7, 'Filed away', 'Body filed.')],
    },
    accountCanSend: true,
    hangCapabilities: false,
    read: [],
    bodyCalls: [],
    removed: [],
  };
  await writeFixtureProvider();
  bus.subscribe('mail-task-observer', (event) => {
    if (event.name.startsWith('plugin:mail:')) {
      events.push({
        name: event.name.slice('plugin:mail:'.length),
        data: event.data as Record<string, unknown>,
      });
    }
  }, { global: true, interest: ['plugin:mail:'] });
  // The digest is OFF for the whole first half: every tick below is driven explicitly, and a digest
  // firing inside the task block would make the "disabled sends nothing" claim unprovable.
  await boot({
    poll_interval_seconds: 600,
    max_rows_per_account: 50,
    retention_days: 3650,
    digest_enabled: false,
  });

  const created = await api<{ account: { accountId: string } }>('POST', '/accounts', {
    providerId: 'tasky',
    values: { address: 'alice@example.invalid' },
  });
  expect(created.status).toBe(201);
  await waitForMessages(MESSAGE_COUNT, 60_000);
}, 180_000);

afterAll(async () => {
  bus.unsubscribe('mail-task-observer');
  await stopServer();
  delete (globalThis as unknown as { __mailTaskDigest?: Fixture }).__mailTaskDigest;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

function eventsOf(name: string): Array<Record<string, unknown>> {
  return events.filter((event) => event.name === name).map((event) => event.data);
}

/** The task ids this file made, so the retention and digest blocks can rely on them existing. */
const made: Record<string, string> = {};

describe('one message becomes one task', () => {
  it('records where it came from, tags it, and hands back 201', async () => {
    events.length = 0;
    const answered = await makeTask(KICKOFF);
    expect(answered.status).toBe(201);
    expect(answered.body.created).toBe(true);
    made[KICKOFF] = answered.body.taskId!;

    const task = await getTask(answered.body.taskId!);
    expect(task.title).toBe('Kickoff for the cranberry launch');
    expect(task.tags).toEqual([MAIL_TASK_TAG]);
    // Inbox, because no project was asked for. `''` and undefined are the same thing to a reader.
    expect(task.project || '').toBe('');
    expect(task.phase).toBe('TODO');

    // The provenance block: who, when, which account, and the way back. The link is the CORE app's
    // route with both ids percent-encoded, so an id containing a colon or an ampersand survives.
    expect(task.description).toContain('From: Alice Nguyen &lt;alice@example.invalid&gt;');
    expect(task.description).toContain('Account: Fixture mailbox');
    // A markdown LINK, because the description is rendered as markdown and a bare path is a
    // copy-and-paste job. The route is the CORE app's with both ids percent-encoded, so an id
    // containing a colon or an ampersand survives.
    expect(task.description).toContain(
      `Open in Mail: [open in Mail](/mail?account=${encodeURIComponent(ACCOUNT_ID)}`
      + `&message=${encodeURIComponent(KICKOFF)})`,
    );
    // The snippet rides as a quoted block, under the lines it must not be able to impersonate.
    expect(task.description).toContain('> Body of the kickoff mail.');

    expect(eventsOf('message-tasked')).toEqual([
      { accountId: ACCOUNT_ID, messageId: KICKOFF, taskId: answered.body.taskId },
    ]);
  }, 60_000);

  it('answers a second press with the same task and 200, and makes nothing', async () => {
    const before = (await rows('SELECT rfc_message_id FROM message_tasks')).length;
    const again = await makeTask(KICKOFF);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ taskId: made[KICKOFF], created: false });
    expect((await rows('SELECT rfc_message_id FROM message_tasks')).length).toBe(before);
  });

  it('takes an explicit title and a project when it is given them', async () => {
    const answered = await makeTask(HOSTILE, { title: 'Check the wire request', project: 'Finance' });
    expect(answered.status).toBe(201);
    made[HOSTILE] = answered.body.taskId!;
    const task = await getTask(answered.body.taskId!);
    // A caller's own title is Walnut-side text and is placed as written; only the SUBJECT is
    // untrusted, and that one is not in the title here.
    expect(task.title).toBe('Check the wire request');
    expect(task.project).toBe('Finance');
  });

  it('creates a new task when the ledger points at one the human deleted', async () => {
    await deleteTask(made[HOSTILE]!);
    const answered = await makeTask(HOSTILE);
    expect(answered.status).toBe(201);
    expect(answered.body.created).toBe(true);
    expect(answered.body.taskId).not.toBe(made[HOSTILE]);
    made[HOSTILE] = answered.body.taskId!;

    // Repointed, not duplicated: one row per message, whatever happened to the task.
    const ledger = await rows<{ task_id: string }>(
      'SELECT task_id FROM message_tasks WHERE rfc_message_id = ?',
      ['rfc:<m3.INBOX@example.invalid>'],
    );
    expect(ledger.map((row) => row.task_id)).toEqual([made[HOSTILE]]);
  });

  it('refuses a message it has never seen without creating anything', async () => {
    const before = (await rows('SELECT rfc_message_id FROM message_tasks')).length;
    const answered = await makeTask('INBOX:100:999');
    expect(answered.status).toBe(404);
    expect((await rows('SELECT rfc_message_id FROM message_tasks')).length).toBe(before);
  });
});

describe('a subject reaches the task the way the sender typed it', () => {
  /**
   * The TITLE is deliberately not escaped, and that is a correction rather than an omission.
   *
   * A task title is rendered as a plain text node everywhere Walnut shows one, so escaping it
   * defuses nothing and only publishes the backslashes: `Q&A [urgent]` reached the board as
   * `Q&amp;A \[urgent\]`, which hides what the mail said. The escaping belongs to the fields that
   * ARE rendered as markdown, which is the description, and to the digest letter; both are graded
   * below and in `renderDigest`'s own block.
   */
  it('keeps the subject verbatim in the title, which is never rendered as markdown', async () => {
    // No title this time, so the SUBJECT is what becomes the title.
    await runSql('DELETE FROM message_tasks WHERE rfc_message_id = ?', ['rfc:<m3.INBOX@example.invalid>']);
    const answered = await makeTask(HOSTILE);
    expect(answered.status).toBe(201);
    made[HOSTILE] = answered.body.taskId!;
    const task = await getTask(answered.body.taskId!);

    expect(task.title).toBe(HOSTILE_SUBJECT);
    expect(task.title).not.toContain('\\');
    expect(task.title).not.toContain('&lt;');
  });

  it('escapes the description, which IS rendered as markdown', async () => {
    const task = await getTask(made[HOSTILE]!);
    // The sender's display name and the snippet are the untrusted halves of a markdown document
    // Walnut authors, so the angle brackets around an address are entities and cannot open a tag.
    expect(task.description).toContain('From: Alice Nguyen &lt;alice@example.invalid&gt;');
    expect(task.description).not.toContain('<alice@example.invalid>');
    // And the snippet is quoted, so no amount of markup in it reads as one of the lines above it.
    expect(task.description).toContain('> A short body.');
  });

  it('bounds the title, so a subject cannot be a paragraph', async () => {
    const answered = await makeTask(LONG);
    expect(answered.status).toBe(201);
    made[LONG] = answered.body.taskId!;
    const task = await getTask(answered.body.taskId!);
    expect(task.title).toBe(`${'L'.repeat(TASK_TITLE_CHARS)}...`);
  });
});

describe('note: true appends the body, bounded', () => {
  it('quotes the first 2 KB and says where the rest is', async () => {
    // Same message, and the ledger already has it: the note rides an EXISTING task rather than a
    // second one, which is what the idempotent shape has to allow for.
    await runSql('DELETE FROM message_tasks WHERE rfc_message_id = ?', ['rfc:<m4.INBOX@example.invalid>']);
    const answered = await makeTask(LONG, { note: true });
    expect(answered.status).toBe(201);
    expect(answered.body.noteSkipped).toBeUndefined();
    made[LONG] = answered.body.taskId!;

    const task = await getTask(answered.body.taskId!);
    expect(task.note).toBeTruthy();
    // Quoted, so nothing in the body can read as the task's own words.
    expect(task.note!.startsWith('> ')).toBe(true);
    expect(task.note).toContain('plenty of body');
    // The cap held: the tail of a 6 KB body is not in the note, and the human is told so.
    expect(task.note).not.toContain(BODY_TAIL);
    expect(task.note).toContain('The rest of the message is in Mail.');
    expect(Buffer.byteLength(task.note!, 'utf8')).toBeLessThan(3 * 1024);
  }, 60_000);
});

describe('the backlink flows to every read path', () => {
  it('puts taskId on the list, the single read and the search answer', async () => {
    const listed = await api<{ messages: Array<{ messageId: string; taskId?: string }> }>(
      'GET',
      `/messages?account=${encodeURIComponent(ACCOUNT_ID)}&limit=50`,
    );
    const byId = new Map(listed.body.messages.map((one) => [one.messageId, one.taskId]));
    expect(byId.get(KICKOFF)).toBe(made[KICKOFF]);
    // And nothing invents one for a message nobody made a task from.
    expect(byId.get(ANCIENT)).toBeUndefined();

    const one = await api<{ message: { taskId?: string; cc?: unknown[]; replyTo?: unknown[] } }>(
      'GET',
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(KICKOFF)}`,
    );
    expect(one.body.message.taskId).toBe(made[KICKOFF]);

    const found = await api<{ messages: Array<{ messageId: string; taskId?: string }> }>(
      'GET',
      `/search?account=${encodeURIComponent(ACCOUNT_ID)}&q=kickoff`,
    );
    const hit = found.body.messages.find((row) => row.messageId === KICKOFF);
    expect(hit?.taskId).toBe(made[KICKOFF]);
  }, 60_000);

  it('carries cc and reply-to on the DTO, from the payload blob', async () => {
    const one = await api<{ message: { cc?: Array<{ name?: string; address: string }>; replyTo?: Array<{ address: string }> } }>(
      'GET',
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(KICKOFF)}`,
    );
    expect(one.body.message.cc).toEqual([{ name: 'Doe, Jane', address: 'jane@example.invalid' }]);
    expect(one.body.message.replyTo).toEqual([{ address: 'desk@example.invalid' }]);
  });

  it('prefers the ACCOUNT capability over the provider block', async () => {
    // The provider says `send: false`; this account says true. An account DTO that reported the
    // provider's answer would hide the Send button from an account that can use it.
    const listed = await api<{ accounts: Array<{ accountId: string; capabilities?: { send: boolean } }> }>(
      'GET',
      '/accounts',
    );
    expect(listed.body.accounts[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      capabilities: { send: true },
    });
  });
});

describe('the agent reaches the same one implementation', () => {
  it('makes the task through mail_to_task and says what happened in words', async () => {
    await runSql('DELETE FROM message_tasks WHERE rfc_message_id = ?', ['rfc:<m6.INBOX@example.invalid>']);
    const answered = await tool('mail_to_task', { message: 'INBOX:100:6' });
    const [first, ...rest] = answered.split('\n');
    const parsed = JSON.parse(first!) as { taskId: string; created: boolean };
    expect(parsed.created).toBe(true);
    expect(rest.join('\n')).toContain('It is in TODO for the user to pick up.');
    const task = await getTask(parsed.taskId);
    expect(task.title).toBe('Fifth');

    // The second call is the retry an agent makes after re-reading its transcript.
    const again = await tool('mail_to_task', { message: 'INBOX:100:6' });
    const parsedAgain = JSON.parse(again.split('\n')[0]!) as { taskId: string; created: boolean };
    expect(parsedAgain).toEqual({ taskId: parsed.taskId, created: false });
    expect(again).toContain('already had a task');
  }, 60_000);

  it('shows the backlink in mail_read and in the mail_list table', async () => {
    const read = await tool('mail_read', { message: KICKOFF });
    expect(read).toContain(`Task: ${made[KICKOFF]}`);
    const listed = await tool('mail_list', { mailbox: 'inbox', limit: 50 });
    expect(listed).toContain('\ttask\t');
    expect(listed).toContain(made[KICKOFF]!);
  }, 60_000);
});

describe('a disabled digest does nothing at all', () => {
  it('sends no letter on a full tick', async () => {
    expect(await mailLetters()).toEqual([]);
    await mailSyncForTesting()!.runTick({ force: true });
    expect(await mailLetters()).toEqual([]);
    expect(await digestDay()).toBeUndefined();
  }, 60_000);
});

/*
 * Retention needs a different cap, so it restarts the server. The cache on disk survives, which is
 * what makes the "a task-linked row is never evicted" claim about the real sweep.
 */
describe('retention keeps what a task points at', () => {
  it('evicts the unlinked overflow and keeps every linked row', async () => {
    // Three of the four oldest rows are linked by now (Kickoff, Hostile, Long); `Ancient` is not.
    const linked = await rows<{ rfc_message_id: string }>('SELECT rfc_message_id FROM message_tasks');
    expect(linked.map((row) => row.rfc_message_id).sort()).toEqual([
      'rfc:<m2.INBOX@example.invalid>',
      'rfc:<m3.INBOX@example.invalid>',
      'rfc:<m4.INBOX@example.invalid>',
      'rfc:<m6.INBOX@example.invalid>',
    ]);

    await reboot({
      poll_interval_seconds: 600,
      max_rows_per_account: 3,
      retention_days: 3650,
      digest_enabled: false,
    });
    await mailSyncForTesting()!.runTick({ force: true });

    const kept = await rows<{ message_id: string }>('SELECT message_id FROM messages ORDER BY sent_at');
    const ids = kept.map((row) => row.message_id);
    // The cap selected the four oldest; only the ONE that nothing links went.
    expect(ids).not.toContain(ANCIENT);
    expect(ids).toContain(KICKOFF);
    expect(ids).toContain(HOSTILE);
    expect(ids).toContain(LONG);
    expect(ids).toHaveLength(MESSAGE_COUNT - 1);

    // And the tasks are untouched: a sweep of a CACHE may never reach the human's own rows.
    await expect(getTask(made[KICKOFF]!)).resolves.toMatchObject({ id: made[KICKOFF] });
  }, 180_000);
});

/*
 * The digest. `digest_time: '00:00'` makes it due at every hour of the day, so the SCHEDULE is
 * decided by the stored day key alone and no assertion below depends on when this file is run.
 */
const DIGEST_CONFIG = {
  poll_interval_seconds: 600,
  max_rows_per_account: 3,
  retention_days: 3650,
  digest_enabled: true,
  digest_time: '00:00',
  digest_max_items: 2,
};

describe('the daily digest letter', () => {

  it('sends one letter, listing the newest unread and counting the rest', async () => {
    await reboot(DIGEST_CONFIG);
    events.length = 0;
    await mailSyncForTesting()!.runTick({ force: true });

    const letters = await mailLetters();
    expect(letters).toHaveLength(1);
    const letter = letters[0]!;
    // Informational, never pinned, never a question: there is nothing here to decide, and
    // tomorrow's digest would sit under a pin.
    expect(letter.type).toBe('info');
    expect(letter.actions ?? []).toEqual([]);
    expect(letter.pinned ?? false).toBe(false);
    // SIX, from the mailbox the provider reports, which is the same number the sidebar badge shows.
    // The cache holds only five of them by now (retention evicted `Ancient` above), and that gap is
    // the whole reason the count is taken from the mailbox rather than from the cached rows: two
    // numbers for one question is how a letter saying "5 unread" ends up beside a badge saying 6.
    expect(await inboxUnreadRows()).toBe(5);
    expect(letter.subject).toBe('Mail digest: 6 unread across 1 account');

    const body = await letterBody(letter.id);
    expect(body).toContain('### Fixture mailbox (6 unread)');
    // Newest first, capped at `digest_max_items`, with the remainder counted rather than guessed
    // from the length of a truncated page.
    expect(body).toContain('- **Alice Nguyen**: Fifth (');
    expect(body).toContain('- **Alice Nguyen**: Fourth (');
    expect(body).not.toContain('Kickoff');
    expect(body).toContain('and 4 more');
    // A markdown link, so the one thing this letter asks for is one tap on a phone.
    expect(body).toContain(`[Open Mail](/mail?account=${encodeURIComponent(ACCOUNT_ID)})`);

    expect(eventsOf('digest-sent')).toEqual([{ letterId: letter.id, unread: 6 }]);
    expect(await digestDay()).toBe(localDay(Date.now()));
  }, 120_000);

  it('sends nothing on the next tick of the same day', async () => {
    await mailSyncForTesting()!.runTick({ force: true });
    await mailSyncForTesting()!.runTick({ force: true });
    expect(await mailLetters()).toHaveLength(1);
  }, 120_000);

  it('sends again once the day key is yesterday', async () => {
    await runSql('UPDATE meta SET value = ? WHERE key = ?', ['2020-01-01', DIGEST_DAY_KEY]);
    await mailSyncForTesting()!.runTick({ force: true });
    expect(await mailLetters()).toHaveLength(2);
    expect(await digestDay()).toBe(localDay(Date.now()));
  }, 120_000);

  it('send-now sends immediately and does NOT spend the day', async () => {
    const answered = await api<{ letterId: string | null; unread: number }>('POST', '/digest/send-now');
    expect(answered.status).toBe(200);
    expect(answered.body.letterId).toBeTruthy();
    expect(answered.body.unread).toBe(6);
    expect(await mailLetters()).toHaveLength(3);
    // Still today's key, untouched: somebody looking at lunchtime must not swallow tomorrow morning's.
    expect(await digestDay()).toBe(localDay(Date.now()));

    // And the scheduled one is still suppressed, which is what "did not spend the day" means.
    await mailSyncForTesting()!.runTick({ force: true });
    expect(await mailLetters()).toHaveLength(3);
  }, 120_000);

  it('marks the day without a letter when nothing is unread', async () => {
    // Read on the SERVER, which is what the next mailbox listing reports and what the flags on the
    // cached rows then agree with. Both halves, because the count comes from the mailbox and the
    // items from the cache, and a test that moved only one of them would prove nothing.
    marks().read = allMessageIds();
    // Both columns, because `seen` is derived from the array on every STORE write and this write
    // goes around the store: a row whose two columns disagree is a bug this test would otherwise plant.
    await runSql("UPDATE messages SET flags_json = '[\"\\\\Seen\"]', seen = 1");
    await runSql('UPDATE meta SET value = ? WHERE key = ?', ['2020-01-01', DIGEST_DAY_KEY]);

    await mailSyncForTesting()!.runTick({ force: true });
    // No letter that says there is no news, and no second attempt later today either.
    expect(await mailLetters()).toHaveLength(3);
    expect(await digestDay()).toBe(localDay(Date.now()));

    const nothing = await api<{ letterId: string | null; unread: number }>('POST', '/digest/send-now');
    expect(nothing.body).toMatchObject({ letterId: null, unread: 0 });
    expect(await mailLetters()).toHaveLength(3);
  }, 120_000);
});

/**
 * The mailbox counter is the ONE number the badge and the digest share, so it has to follow a read
 * flag Walnut itself changed.
 *
 * It used to be the provider's last figure until the next mailbox re-list, which is a whole poll
 * interval away: a digest sent inside that window said "2 unread" over a list of one message, and a
 * second tab's badge disagreed with the tab the message had been read in. A re-list still overrides
 * it, which is the right precedence; this only keeps it honest in between.
 */
describe('a read flag moves the count with it', () => {
  const FIFTH = 'INBOX:100:6';

  function setRead(read: boolean): Promise<{ status: number; body: unknown }> {
    return api(
      'POST',
      `/messages/${encodeURIComponent(ACCOUNT_ID)}/${encodeURIComponent(FIFTH)}/read`,
      { read },
    );
  }

  function unreadInbox(): Promise<number | undefined> {
    return api<{ accounts: Array<{ unreadInbox?: number }> }>('GET', '/accounts')
      .then((answer) => answer.body.accounts[0]?.unreadInbox);
  }

  it('counts one again the moment a message is marked unread, with no re-list', async () => {
    // Everything is read on both sides by now (the block above), and the fixture's provider still
    // reports every message as read: nothing but this write can move the number.
    expect(await unreadInbox()).toBe(0);
    expect((await setRead(false)).status).toBe(200);
    expect(await unreadInbox()).toBe(1);

    const sent = await api<{ letterId: string | null; unread: number }>('POST', '/digest/send-now');
    expect(sent.body.unread).toBe(1);
    const body = await letterBody(sent.body.letterId!);
    expect(body).toContain('### Fixture mailbox (1 unread)');
    expect(body).toContain('Fifth');

    // And back out again, which is the direction the console takes every time a human opens a mail.
    expect((await setRead(true)).status).toBe(200);
    expect(await unreadInbox()).toBe(0);
  }, 120_000);
});

/**
 * Before its hour, nothing happens.
 *
 * Driven against `MailDigest` with an injected clock rather than by booting a server at a chosen
 * time: the property is one comparison of local minutes, and a wall-clock-dependent assertion
 * through the real server would be a test that fails at breakfast.
 */
/**
 * One `MailDigest` over fakes, with a clock the test owns.
 *
 * Used by the two properties that are about the CLOCK and the BUDGET rather than about a transport:
 * both would otherwise need a server booted at a chosen hour, which is a test that fails at
 * breakfast, or a database slow enough to run out of budget, which is not a thing a test can arrange.
 */
function fakeDigest(over: { digestTime?: string } = {}) {
  const sent: string[] = [];
  const meta = new Map<string, string>();
  let now = startOfLocalDay(Date.UTC(2026, 4, 10, 12, 0, 0));
  const digest = new MailDigest({
    store: {
      unreadByAccount: async () => new Map([['x:one', { total: 3, inbox: 3 }]]),
      tasks: {
        getMeta: async (key: string) => meta.get(key),
        setMeta: async (key: string, value: string) => { meta.set(key, value); },
        unreadInboxMessages: async () => [
          { payload: null, from_addr: 'zoe@example.invalid', subject: 'Only one', sent_at: now - 1_000 },
        ],
      },
    } as never,
    events: { digestSent: () => undefined } as never,
    letters: { send: async () => { sent.push('letter'); return { letterId: `l${sent.length}` } } },
    accounts: async () => [{
      accountId: 'x:one', providerId: 'x', displayName: 'One', address: 'one@example.invalid',
      state: 'active',
    }] as never,
    config: { get: async () => ({ digest_time: over.digestTime ?? '08:00' }) as never },
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    now: () => now,
  });
  return {
    digest,
    sent,
    meta,
    /** Move the clock to `hour` local, on the day the fixture is set to. */
    at(hour: number) { now = startOfLocalDay(Date.UTC(2026, 4, 10, 12, 0, 0)) + hour * 60 * 60_000; },
    /** The local day key the injected clock is on, which is what the digest stores. */
    today() { return localDay(now); },
  };
}

describe('the digest waits for its hour', () => {
  it('does nothing before digest_time and sends after it', async () => {
    const { digest, sent, at } = fakeDigest();
    // Expressed through the same local day the class uses, so this holds in every timezone.
    at(1);
    expect(await digest.maybeSend()).toBeNull();
    expect(sent).toEqual([]);

    at(9);
    const answered = await digest.maybeSend();
    expect(answered).toMatchObject({ unread: 3 });
    expect(sent).toEqual(['letter']);
    // And the day is spent, so the next tick of the same day does nothing.
    expect(await digest.maybeSend()).toBeNull();
    expect(sent).toEqual(['letter']);
  });
});

/**
 * A tick that ran out of budget must not be able to say "nothing was unread".
 *
 * The two readings are the SAME NUMBER from a caller's side, and the difference matters: a tick that
 * reached the digest with its budget spent collected nothing, rendered zero unread, marked the day
 * and sent no letter, so a mailbox with unread mail in it lost its digest until the next morning.
 * `send-now` under the same condition told the human "nothing is unread", which is a lie they cannot
 * act on, where "try again" is a button they can press.
 */
describe('an unfinished cache read never spends the day', () => {
  it('sends nothing, marks nothing, and leaves the next tick to do it', async () => {
    const { digest, sent, meta, at, today } = fakeDigest();
    at(9);

    // A deadline already in the past is exactly the shape of a tick that arrived with no budget: the
    // collect loop checks the clock before it looks at its first account.
    expect(await digest.maybeSend(Date.now() - 1)).toBeNull();
    expect(sent).toEqual([]);
    expect(meta.get(DIGEST_DAY_KEY)).toBeUndefined();

    // The very next tick, with budget, does the work. This is the half that proves the deferral is a
    // deferral rather than a silent loss.
    const answered = await digest.maybeSend();
    expect(answered).toMatchObject({ unread: 3 });
    expect(sent).toEqual(['letter']);
    expect(meta.get(DIGEST_DAY_KEY)).toBe(today());
  });

  it('send-now says it ran out of time instead of claiming nothing is unread', async () => {
    const { digest, sent } = fakeDigest();
    const answered = await digest.sendNow(Date.now() - 1);
    expect(answered).toMatchObject({ letterId: null, unread: 0, incomplete: true });
    expect(answered.message).toBe(DIGEST_INCOMPLETE_MESSAGE);
    expect(sent).toEqual([]);
    // Nothing about `digest_enabled` or the hour gates send-now: the human asking is the consent.
    const full = await digest.sendNow();
    expect(full).toMatchObject({ unread: 3, letterId: 'l1' });
    expect(full.incomplete).toBeUndefined();
    expect(full.message).toBeUndefined();
    expect(sent).toEqual(['letter']);
  });
});

/** Local midnight for whatever day `at` falls on, without a timezone library. */
function startOfLocalDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * A replica sends nothing, and the reason is structural: nothing ticks there.
 *
 * Driven against the loop with a fake host rather than by booting a second server in cloud mode,
 * for the same reason `mail-sync.test.ts` does it: cloud mode changes the whole server's shape.
 */
describe('on a replica', () => {
  it('never asks the digest whether one is due', async () => {
    const host = {
      replica: true,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      config: { get: async () => ({}), onChange: () => ({ dispose: () => undefined }) },
      timers: {
        interval: () => ({ dispose: () => undefined }),
        timeout: () => ({ dispose: () => undefined }),
      },
      notifications: { error: async () => undefined, recover: async () => undefined },
    } satisfies MailSyncHost;
    const explode = (what: string) => () => { throw new Error(`a replica must not touch ${what}`) };
    const sync = new MailSync({
      walnut: host,
      store: { listAccounts: explode('the cache') } as never,
      service: {} as never,
      retention: { retain: explode('the retention sweep') } as never,
      events: {} as never,
      digest: { maybeSend: explode('the digest') as never },
    });

    sync.start();
    expect(sync.polling).toBe(false);
    await expect(sync.runTick({ force: true })).resolves.toMatchObject({ polled: 0 });
    await sync.stop();
  });

  // The ROUTE half of the same rule is graded in `mail-sync.test.ts`, which loops every registered
  // mail route and requires 503 `primary_only` from all of them, so both new routes are covered
  // there by construction rather than by a second list here that could fall behind.
});

/*
 * The byte cap, as a property of the render.
 *
 * Stated against `renderDigest` directly because that is where the cap lives and because the
 * scenario it exists for (hundreds of unread across several accounts) is about the SHAPE of the
 * document, not about a transport: `collect` bounds items per account, and what makes a body big
 * is how many accounts and how long their subjects are.
 */
describe('the letter body is capped in bytes', () => {
  function block(index: number, items: number, subjectChars: number): DigestAccountBlock {
    return {
      accountId: `acct:${index}`,
      label: `Mailbox ${index}`,
      unread: 500,
      items: Array.from({ length: items }, (_, at) => ({
        sender: `Sender ${at}`,
        subject: 'S'.repeat(subjectChars),
        sentAt: Date.UTC(2026, 4, 10, 8, 0, 0) - at * 60_000,
      })),
    };
  }

  it('fits 500 unread across 3 accounts under 16 KB and still counts the rest', () => {
    const rendered = renderDigest([block(1, 50, 60), block(2, 50, 60), block(3, 50, 60)], Date.now());
    expect(rendered.subject).toBe('Mail digest: 1500 unread across 3 accounts');
    expect(Buffer.byteLength(rendered.markdown, 'utf8')).toBeLessThan(DIGEST_MAX_BYTES);
    // Each account says how many it did not list, from its own count.
    expect(rendered.markdown.match(/and 450 more$/gm)).toHaveLength(3);
  });

  it('drops WHOLE accounts when the cap bites, and says how many', () => {
    const blocks = Array.from({ length: 40 }, (_, at) => block(at + 1, 50, 200));
    const rendered = renderDigest(blocks, Date.now());
    expect(Buffer.byteLength(rendered.markdown, 'utf8')).toBeLessThan(DIGEST_MAX_BYTES);
    // A body cut mid-list ends in a dangling bullet, which on a phone reads as a rendering bug.
    expect(rendered.markdown.endsWith('more accounts')).toBe(true);
    expect(rendered.markdown).toMatch(/and \d+ more accounts$/);
    for (const section of rendered.markdown.split('\n\n')) {
      if (section.startsWith('- ')) expect(section.split('\n')).toHaveLength(50);
    }
  });

  /**
   * The cap has to bind ONE account too, which is the case dropping whole accounts cannot cover.
   *
   * A single mailbox of fifty 900-character subjects was 46 KB, and it cannot be dropped: there may
   * be no other account, and a digest that renders nothing is worse than a truncated one. Two things
   * hold it now. Every field is CLIPPED to the same per-field cap the agent surface uses, which is
   * what makes the configured ceiling of fifty items safe by arithmetic; and past that the block
   * cuts ITEMS, which is what keeps the renderer safe for any input rather than only for inputs the
   * config can produce.
   */
  it('clips every field, so one mailbox at the item ceiling fits', () => {
    const rendered = renderDigest([block(1, DIGEST_MAX_ITEMS_CEILING, 900)], Date.now());
    expect(Buffer.byteLength(rendered.markdown, 'utf8')).toBeLessThan(DIGEST_MAX_BYTES);
    expect(rendered.markdown).toContain('### Mailbox 1 (500 unread)');
    expect(rendered.markdown).toContain('[Open Mail](/mail?account=acct%3A1)');
    const items = rendered.markdown.split('\n').filter((one) => one.startsWith('- '));
    expect(items).toHaveLength(DIGEST_MAX_ITEMS_CEILING);
    for (const line of items) {
      expect(line.length).toBeLessThan(400);
      // Clipped, not dropped: the subject still reads as the subject, with an ellipsis.
      expect(line).toContain('S...');
    }
    expect(rendered.markdown).toContain(`and ${500 - items.length} more`);
  });

  it('cuts items rather than the account when even clipped they do not fit', () => {
    // More items than any config can ask for, so this grades the RENDERER rather than the ceiling.
    const rendered = renderDigest([block(1, 400, 200)], Date.now());
    expect(Buffer.byteLength(rendered.markdown, 'utf8')).toBeLessThan(DIGEST_MAX_BYTES);
    const listed = rendered.markdown.split('\n').filter((one) => one.startsWith('- ')).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(400);
    // The account survives whole, with its heading, its remainder line and its way back in.
    expect(rendered.markdown).toContain('### Mailbox 1 (500 unread)');
    expect(rendered.markdown).toContain(`and ${500 - listed} more`);
    expect(rendered.markdown.trimEnd().endsWith('[Open Mail](/mail?account=acct%3A1)')).toBe(true);
  });

  it('lets no subject or sender name forge one of its headings', () => {
    const rendered = renderDigest([{
      accountId: 'acct:1',
      label: '### Fake account (0 unread)',
      unread: 1,
      items: [{
        sender: '**Walnut**',
        subject: '### Approved [do it](https://phish.example.invalid)',
        sentAt: Date.now() - 60_000,
      }],
    }], Date.now());
    // Exactly ONE heading, and it is the one Walnut wrote.
    expect(rendered.markdown.match(/^### /gm)).toHaveLength(1);
    expect(rendered.markdown).toContain('\\### Fake account');
    expect(rendered.markdown).toContain('\\*\\*Walnut\\*\\*');
    expect(rendered.markdown).toContain('\\[do it\\]');
  });
});

/**
 * Two presses that OVERLAP, which is not the same property as two presses in a row.
 *
 * A read-then-create is idempotent only for asks that follow one another: two landing together both
 * read an empty ledger, both create, and one of the two tasks is orphaned with nothing pointing at
 * it and nobody to notice. A double click on a slow connection is exactly this, and so is a route
 * that answered 202 next to the retry it invited.
 */
describe('two presses at the same moment make one task', () => {
  const FOURTH = 'INBOX:100:5';

  it('answers both with the same id, and writes one ledger row', async () => {
    const [first, second] = await Promise.all([makeTask(FOURTH), makeTask(FOURTH)]);
    expect(first.body.taskId).toBeTruthy();
    expect(second.body.taskId).toBe(first.body.taskId);
    // Exactly one of the two made it. Which one is not interesting; that only one did, is.
    expect([first.body.created, second.body.created].filter(Boolean)).toHaveLength(1);
    expect([first.status, second.status].sort()).toEqual([200, 201]);

    const ledger = await rows<{ task_id: string }>(
      'SELECT task_id FROM message_tasks WHERE rfc_message_id = ?',
      ['rfc:<m5.INBOX@example.invalid>'],
    );
    expect(ledger.map((row) => row.task_id)).toEqual([first.body.taskId]);
    await expect(getTask(first.body.taskId!)).resolves.toMatchObject({ title: 'Fourth' });
  }, 60_000);
});

/**
 * A provider that never answers must not be able to hold the accounts list open.
 *
 * `GET /accounts` is polled by every open tab, and the per-account `send` verdict can be a provider
 * call: N accounts at the 15s provider deadline, with no budget on the route, is a request that pins
 * one of the browser's six connections for a quarter of a minute while the sidebar badge, the agent
 * surface gate and the digest all wait behind it. The degraded answer is the same list with
 * `capabilities` left out, which is a shape the console already handles by falling back to the
 * provider block.
 */
describe('a wedged provider cannot stall the accounts list', () => {
  it('answers without capabilities instead of waiting', async () => {
    // A restart, because the verdict is cached per account for a minute and the read-path block above
    // already cached this one. A fresh service is the honest way to ask the question again.
    await reboot(DIGEST_CONFIG);
    marks().hangCapabilities = true;
    try {
      const started = Date.now();
      const listed = await api<{ accounts: Array<{ accountId: string; capabilities?: unknown }> }>(
        'GET',
        '/accounts',
      );
      const took = Date.now() - started;
      expect(listed.status).toBe(200);
      expect(listed.body.accounts).toHaveLength(1);
      // The names and the counts are all still there: only the answer nobody could get is missing.
      expect(listed.body.accounts[0]).toMatchObject({ accountId: ACCOUNT_ID });
      expect(listed.body.accounts[0]!.capabilities).toBeUndefined();
      // The contract is a 2s capability deadline inside a 2.5s route budget; the slack is for a
      // loaded machine, and the number that matters is that it is nowhere near 15s.
      expect(took).toBeLessThan(4_000);
    } finally {
      marks().hangCapabilities = false;
    }
  }, 60_000);
});

describe('deleting the account forgets the links and keeps the tasks', () => {
  it('drops every message_tasks row for it, and no task', async () => {
    const survivor = made[KICKOFF]!;
    expect((await rows('SELECT rfc_message_id FROM message_tasks')).length).toBeGreaterThan(0);

    const removed = await api<{ ok: boolean }>('DELETE', `/accounts/${encodeURIComponent(ACCOUNT_ID)}`);
    expect(removed.status).toBe(200);
    expect(marks().removed).toEqual([ACCOUNT_ID]);

    expect(await rows('SELECT rfc_message_id FROM message_tasks')).toEqual([]);
    // The task is the human's. It keeps its provenance block, pointing at a mailbox that is gone,
    // which is honest: the task outlives the cache by design.
    await expect(getTask(survivor)).resolves.toMatchObject({ id: survivor });
  }, 60_000);
});
