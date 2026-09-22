/**
 * `POST /api/plugins/mail/messages/:a/:m/unsubscribe` through a REAL server.
 *
 * Everything below the route is real: the plugin loader, a fixture mail provider, the worker-thread
 * cache with its v8 migration, the event bus, and a real HTTP server on loopback that the unsubscribe
 * transport reaches. The guard is real too, and there is no switch that turns it off — the transport
 * maps the public-looking host to the local port, and the resolver answers with a public address, so
 * every check still runs on `https://lists.example.invalid/...`.
 *
 * The four things this file is here for, none of which a unit test can show:
 *
 * - The ROUTE's answer shapes, including the two 409s and the printable sentence in each.
 * - The response BUDGET. A page that accepts and never answers must not pin a browser connection: the
 *   route answers inside ten seconds and `/health` keeps answering in milliseconds throughout, because
 *   one pinned response is one of the browser's six connections gone.
 * - The ledger surviving the response: a late verdict still lands.
 * - The bus event, in the shape the console subscribes to.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('mail-unsubscribe-route-test'));

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { bus } from '../../src/core/event-bus.js';
import { listLetters } from '../../src/core/human-inbox/store.js';
import { mailDatabaseForTesting } from '../../src/integrations/mail/db.js';
import { setUnsubscribeHttpForTesting } from '../../src/integrations/mail/unsubscribe-http.js';
import { startServer, stopServer } from '../../src/web/server.js';

const FIXTURE_ID = 'mail-unsub-fixture';
const ACCOUNT = 'unsub:one';
const HOST = 'lists.example.invalid';

/** One-click, mailto-only, footer-link-only, and nothing at all. */
const ONE_CLICK = 'INBOX:700:1';
const MAILTO_ONLY = 'INBOX:700:2';
const FOOTER_ONLY = 'INBOX:700:3';
const NOTHING = 'INBOX:700:4';

/**
 * Where the fixture writes every mail it was asked to send.
 *
 * A FILE rather than a global, because the provider runs inside the plugin loader's own module graph and
 * shares nothing with this test but the filesystem. Under the mocked `WALNUT_HOME`, so it is thrown away
 * with the run.
 */
const OUTBOX_FILE = path.join(WALNUT_HOME, 'unsub-fixture-sends.json');

/** The one draft this file's mailto case creates, by id. */
async function onlyDraftId(): Promise<string> {
  const held = await rows<{ draft_id: string }>('SELECT draft_id FROM drafts');
  expect(held).toHaveLength(1);
  return held[0]!.draft_id;
}

/**
 * How many letters the mail plugin has sent. Read through the REAL inbox store.
 *
 * The assertion this exists for is a ZERO: the mailto rung's whole design is that a right-click is the
 * authorisation, so a letter here would mean it asked for permission it already had.
 */
async function mailLetterCount(): Promise<number> {
  const { letters } = await listLetters();
  return letters.filter((letter) => letter.sender.pluginId === 'mail').length;
}

/** Every send the base asked the fixture for, in order. */
async function outbox(): Promise<Array<{
  to: Array<{ address: string }>;
  cc: unknown[];
  bcc: unknown[];
  subject: string;
  bodyMarkdown: string;
  idempotencyKey: string;
}>> {
  try { return JSON.parse(await fsp.readFile(OUTBOX_FILE, 'utf8')); }
  catch { return []; }
}

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
interface Route { status?: number; body?: string; headers?: Record<string, string>; hang?: boolean }

let server: HttpServer;
let port = 0;
let listEndpoint: http.Server;
let listPort = 0;
const seen: Seen[] = [];
const routes = new Map<string, Route>();
const held: http.ServerResponse[] = [];
const events: Array<{ name: string; data: Record<string, unknown> }> = [];

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

interface UnsubscribeAnswer {
  ok?: boolean;
  status?: string;
  method?: string;
  reason?: string;
  detail?: string;
  url?: string;
  message?: string;
  error?: string;
  unsubscribe?: Record<string, unknown>;
}

function unsubscribe(messageId: string, body: unknown = {}) {
  return api<UnsubscribeAnswer>(
    'POST',
    `/messages/${encodeURIComponent(ACCOUNT)}/${encodeURIComponent(messageId)}/unsubscribe`,
    body,
  );
}

async function rows<T extends Record<string, unknown>>(sql: string, params?: unknown): Promise<T[]> {
  const db = mailDatabaseForTesting();
  expect(db, 'the mail plugin must have an open database').not.toBeNull();
  return db!.all<T>(sql, params);
}

async function runSql(sql: string, params?: unknown): Promise<void> {
  await mailDatabaseForTesting()!.run(sql, params);
}

function release(body = 'You have been unsubscribed.'): void {
  for (const response of held.splice(0)) {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(body);
  }
}

async function writeFixtureProvider(): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', FIXTURE_ID);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Mail Unsubscribe Fixture',
    description: 'A mail provider whose messages carry every shape of List-Unsubscribe',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    dependencies: { mail: '^1.0.0' },
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
import fs from 'node:fs';

const HOST = '${HOST}';
const OUTBOX = ${JSON.stringify(OUTBOX_FILE)};

const MESSAGES = [
  {
    uid: 1,
    subject: 'Marina Weekly, issue 1',
    listUnsubscribe: {
      https: ['https://' + HOST + '/u/one-click'],
      mailto: ['mailto:leave@' + HOST],
      oneClick: true,
      listId: 'weekly.' + HOST,
    },
    html: '<p>Issue one.</p>',
  },
  {
    uid: 2,
    subject: 'Moorings Monthly, issue 2',
    listUnsubscribe: {
      mailto: ['mailto:leave-monthly@' + HOST],
      oneClick: false,
      listId: 'monthly.' + HOST,
    },
    html: '<p>Issue two.</p>',
  },
  {
    uid: 3,
    subject: 'Tides Digest, issue 3',
    // No headers at all: the footer is the only way out, and the base has to find it.
    html: '<p>Issue three.</p><p><a href="https://' + HOST + '/u/footer">Unsubscribe</a></p>',
  },
  {
    uid: 4,
    subject: 'A plain note from a person',
    html: '<p>Lunch on Thursday?</p>',
  },
];

function envelopeOf(message) {
  return {
    messageId: 'INBOX:700:' + message.uid,
    rfcMessageId: '<msg-' + message.uid + '@' + HOST + '>',
    mailboxId: 'INBOX',
    from: { name: 'Marina Weekly', address: 'weekly@' + HOST },
    to: [{ address: 'reader@example.invalid' }],
    subject: message.subject,
    sentAt: Date.UTC(2026, 8, 10 + message.uid, 9, 0, 0),
    flags: [],
    attachments: [],
    ...(message.listUnsubscribe ? { listUnsubscribe: message.listUnsubscribe } : {}),
  };
}

const CAPABILITIES = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  // SENDABLE, because S8's mailto rung really sends: a fixture that refused would only ever exercise
  // the cannot-send branch, and the approval_kind / approval_ref row this file asserts on would
  // never be written at all.
  threads: false, send: true, sendAsReply: false, bodies: 'both', attachments: 'none',
};

function recordSend(entry) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(OUTBOX, 'utf8')); } catch { held = []; }
  held.push(entry);
  // Written to a temp file and RENAMED, because the test reads it while this writes: a plain write is
  // observable half-finished and the reader would parse a truncated file.
  const staging = OUTBOX + '.' + process.pid + '.tmp';
  fs.writeFileSync(staging, JSON.stringify(held, null, 2));
  fs.renameSync(staging, OUTBOX);
}

export function activate(walnut) {
  const base = walnut.services.require('mail:base');
  const handle = base.registerProvider({
    id: 'unsub',
    label: 'Unsubscribe fixture',
    capabilities: CAPABILITIES,
    setup: {
      fields: [{ name: 'which', label: 'Which', kind: 'text' }],
      submit: async () => ({
        accountId: '${ACCOUNT}',
        providerId: 'unsub',
        displayName: 'A mailbox full of newsletters',
        address: 'reader@example.invalid',
        state: 'active',
      }),
    },
    listAccounts: async () => [{
      accountId: '${ACCOUNT}', providerId: 'unsub',
      displayName: 'A mailbox full of newsletters',
      address: 'reader@example.invalid', state: 'active',
    }],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [
      { mailboxId: 'INBOX', name: 'INBOX', role: 'inbox', unread: 0, total: MESSAGES.length },
    ],
    poll: async (_accountId, request) => ({
      messages: request.mailbox === 'INBOX' ? MESSAGES.map(envelopeOf) : [],
      cursor: '700:' + MESSAGES.length,
      more: false,
    }),
    getBody: async (_accountId, messageId) => {
      const uid = Number(messageId.split(':').pop());
      const found = MESSAGES.find((one) => one.uid === uid);
      const html = found ? found.html : '<p>nothing</p>';
      return { format: 'both', text: 'Plain text.', html, bytes: Buffer.byteLength(html) };
    },
    // The mailto rung's transport. It RECORDS rather than swallows, so the test can assert on the one
    // mail that went out (one recipient, the subject the header asked for) instead of on the console's
    // own words. The idempotency key rides along because it is draftId:revision -- two rows with one
    // key is the failure the whole approval ledger exists to prevent.
    send: async (accountId, mail, options) => {
      recordSend({
        accountId,
        to: mail.to,
        cc: mail.cc ?? [],
        bcc: mail.bcc ?? [],
        subject: mail.subject,
        bodyMarkdown: mail.bodyMarkdown,
        idempotencyKey: (options && options.idempotencyKey) || '',
        at: Date.now(),
      });
      return { providerMessageId: '<unsub-fixture-1@' + HOST + '>', acceptedAt: Date.now() };
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
  await writeFixtureProvider();

  // The endpoint the unsubscribe links point at, on loopback, answering real bytes.
  listEndpoint = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const route = routes.get(request.url ?? '') ?? { status: 404, body: 'no such page' };
      if (route.hang) { held.push(response); return; }
      response.writeHead(route.status ?? 200, {
        'content-type': 'text/html; charset=utf-8',
        ...(route.headers ?? {}),
      });
      response.end(route.body ?? '');
    });
  });
  await new Promise<void>((resolve) => listEndpoint.listen(0, '127.0.0.1', resolve));
  listPort = (listEndpoint.address() as AddressInfo).port;

  // The SOCKET and the RESOLVER, and nothing else. The guard still runs on the public url.
  setUnsubscribeHttpForTesting({
    fetch: (url, init) => fetch(url.replace(`https://${HOST}`, `http://127.0.0.1:${listPort}`), init),
    lookup: async (hostname) => {
      if (hostname === HOST) return [{ address: '203.0.113.10', family: 4 }];
      throw new Error(`ENOTFOUND ${hostname}`);
    },
  });

  bus.subscribe('mail-unsub-observer', (event) => {
    if (event.name === 'plugin:mail:unsubscribed') {
      events.push({ name: event.name, data: event.data as Record<string, unknown> });
    }
  }, { global: true, interest: ['plugin:mail:'] });

  await fsp.writeFile(
    CONFIG_FILE,
    yaml.dump({
      version: 1,
      user: { name: 'test' },
      defaults: { priority: 'none' },
      plugins: { mail: { poll_interval_seconds: 3600, retention_days: 3650 } },
    }),
    'utf-8',
  );
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;

  const created = await api<{ account: { accountId: string } }>('POST', '/accounts', {
    providerId: 'unsub',
    values: { which: 'one' },
  });
  expect(created.status).toBe(201);

  // Wait for the kicked poll to land all four envelopes.
  const until = Date.now() + 30_000;
  while (Date.now() < until && (await rows('SELECT rowid FROM messages')).length < 4) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(await rows('SELECT rowid FROM messages')).toHaveLength(4);

  // Then read every body once, so the cache is in a KNOWN state for the whole file. The tick's own
  // body prefetch would otherwise do this at a moment nothing here controls, and "has the footer been
  // scraped yet" would be a race rather than a fact. The pre-body state (nothing captured, so nothing
  // offered) is pinned where it can be controlled, in the ladder's own test.
  for (const messageId of [ONE_CLICK, MAILTO_ONLY, FOOTER_ONLY, NOTHING]) {
    const read = await api<{ message: unknown }>(
      'GET', `/messages/${encodeURIComponent(ACCOUNT)}/${encodeURIComponent(messageId)}`,
    );
    expect(read.status, `body of ${messageId}`).toBe(200);
  }
  expect(await rows('SELECT rowid FROM messages WHERE body_ref IS NOT NULL')).toHaveLength(4);
}, 180_000);

beforeEach(async () => {
  seen.length = 0;
  events.length = 0;
  routes.clear();
  release();
  await runSql('DELETE FROM unsubscribes');
});

afterAll(async () => {
  bus.unsubscribe('mail-unsub-observer');
  setUnsubscribeHttpForTesting(null);
  release();
  await stopServer();
  await new Promise((resolve) => listEndpoint.close(resolve));
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

describe('the availability every message reports without a request', () => {
  it('names the rung each one can be handed to, and says none honestly', async () => {
    const page = await api<{ messages: Array<{ messageId: string; unsubscribe?: { available: string } }> }>(
      'GET', `/messages?account=${encodeURIComponent(ACCOUNT)}&mailbox=INBOX&limit=10`,
    );
    expect(page.status).toBe(200);
    const byId = new Map(page.body.messages.map((message) => [message.messageId, message]));
    expect(byId.get(ONE_CLICK)!.unsubscribe).toEqual({ available: 'one-click' });
    expect(byId.get(MAILTO_ONLY)!.unsubscribe).toEqual({ available: 'mailto' });
    // The footer-only message has no headers at all; `link` here is the base having scraped its stored
    // markup, which is the only path an account whose transport carries no headers ever has.
    expect(byId.get(FOOTER_ONLY)!.unsubscribe).toEqual({ available: 'link' });
    // A message from a person, with nothing in its headers and no footer: no key at all, which a
    // client reads as `none`. Nothing is invented for it.
    expect(byId.get(NOTHING)!.unsubscribe).toBeUndefined();
  });
});

describe('the happy path', () => {
  it('posts the one-click body once and answers done with a sentence', async () => {
    routes.set('/u/one-click', { status: 200, body: 'ok' });
    const answered = await unsubscribe(ONE_CLICK);
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ ok: true, status: 'done', method: 'one-click' });
    expect(answered.body.message).toContain('Unsubscribed');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/u/one-click', body: 'List-Unsubscribe=One-Click' });
    expect(seen[0]!.headers.cookie).toBeUndefined();

    expect(await rows('SELECT status, method, list_key FROM unsubscribes')).toEqual([
      { status: 'done', method: 'one-click', list_key: `weekly.${HOST}` },
    ]);
    expect(events).toEqual([{
      name: 'plugin:mail:unsubscribed',
      data: {
        accountId: ACCOUNT, messageId: ONE_CLICK, listKey: `weekly.${HOST}`,
        method: 'one-click', status: 'done',
      },
    }]);
  });

  it('opens the link the base scraped out of the footer, for a message with no headers', async () => {
    routes.set('/u/footer', { status: 200, body: '<p>You have been unsubscribed.</p>' });
    const answered = await unsubscribe(FOOTER_ONLY);
    expect(answered.body).toMatchObject({ ok: true, status: 'done', method: 'link' });
    expect(seen.map((one) => one.url)).toEqual(['/u/footer']);
    // With no `List-Id` the ledger keys on the SENDER, which is coarser on purpose (see SCHEMA_V8).
    expect(await rows('SELECT list_key FROM unsubscribes')).toEqual([
      { list_key: `weekly@${HOST}` },
    ]);
  });

  it('carries the ledger into every later read of the page', async () => {
    routes.set('/u/one-click', { status: 200, body: 'ok' });
    await unsubscribe(ONE_CLICK);
    const page = await api<{ messages: Array<{ messageId: string; unsubscribe?: Record<string, unknown> }> }>(
      'GET', `/messages?account=${encodeURIComponent(ACCOUNT)}&mailbox=INBOX&limit=10`,
    );
    const mine = page.body.messages.find((message) => message.messageId === ONE_CLICK)!;
    expect(mine.unsubscribe).toMatchObject({
      available: 'one-click',
      done: { method: 'one-click', scope: 'message' },
    });
  });
});

describe('what the route refuses', () => {
  it('409 unsupported, with a sentence a console can print, for a message with no way out', async () => {
    const answered = await unsubscribe(NOTHING);
    expect(answered.status).toBe(409);
    expect(answered.body.error).toBe('unsupported');
    expect(answered.body.message).toMatch(/no unsubscribe link/i);
    expect(seen).toEqual([]);
    expect(await rows('SELECT status FROM unsubscribes')).toEqual([]);
  });

  it('400 for a method this message does not have, and for a method that is not one', async () => {
    expect((await unsubscribe(MAILTO_ONLY, { method: 'one-click' })).status).toBe(400);
    expect((await unsubscribe(ONE_CLICK, { method: 'telepathy' })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('400 for a body that is not JSON: a broken request is not consent to leave a list', async () => {
    const response = await fetch(
      mailUrl(`/messages/${encodeURIComponent(ACCOUNT)}/${encodeURIComponent(ONE_CLICK)}/unsubscribe`),
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' },
    );
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('404 for a message the cache has never held', async () => {
    const answered = await unsubscribe('INBOX:700:999');
    expect(answered.status).toBe(404);
  });

  it('200 with ok:false when the endpoint refuses, so the console can print why', async () => {
    routes.set('/u/one-click', { status: 403, body: 'no' });
    const answered = await unsubscribe(ONE_CLICK);
    // Not an HTTP error: nothing is wrong with this server or this request. The sender said no.
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ ok: false, status: 'failed' });
    expect(answered.body.message).toMatch(/refused|could not be reached/i);
    expect(await rows('SELECT status FROM unsubscribes')).toEqual([{ status: 'failed' }]);
  });

  it('answers needs-human with the url when the page wants a confirmation', async () => {
    routes.set('/u/footer', {
      status: 200,
      body: '<p>Confirm.</p><form action="/unsubscribe"><button>Yes</button></form>',
    });
    const answered = await unsubscribe(FOOTER_ONLY);
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({
      ok: true, status: 'needs-human', reason: 'confirm-form', url: `https://${HOST}/u/footer`,
    });
  });

});

describe('the mailto rung, end to end', () => {
  it('answers 202 in-flight, sends ONE mail, and files it as the click that authorised it', async () => {
    const answered = await unsubscribe(MAILTO_ONLY);
    // 202, not 200: an SMTP handshake legitimately takes tens of seconds, and this response is holding
    // one of the browser's six connections. The rung answers once the `sends` row exists.
    expect(answered.status).toBe(202);
    expect(answered.body).toMatchObject({ ok: true, completed: false, status: 'in-flight', method: 'mailto' });
    expect(answered.body.message).toContain('unsubscribing you');

    // No socket: this rung is a mail, not a page.
    expect(seen).toEqual([]);

    // The ledger settles on its own, after the response. Polled, because that is exactly the contract:
    // the attempt outlives the request and reports itself.
    const until = Date.now() + 15_000;
    let ledger: Array<{ status: string; method: string; ref: string | null }> = [];
    while (Date.now() < until) {
      ledger = await rows('SELECT status, method, ref FROM unsubscribes');
      if (ledger[0] && ledger[0].status !== 'in-flight') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ledger[0]).toMatchObject({ status: 'done', method: 'mailto' });

    // EXACTLY ONE draft and ONE send, and the send names the CLICK rather than a generic console send.
    expect(await rows('SELECT draft_id FROM drafts')).toHaveLength(1);
    const sends = await rows<{ approval_kind: string; approval_ref: string; state: string; send_id: string }>(
      'SELECT send_id, approval_kind, approval_ref, state FROM sends',
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      approval_kind: 'console',
      approval_ref: `unsubscribe:${MAILTO_ONLY}`,
      state: 'sent',
    });
    // The ledger points at the row that carried the mail, which is the only join between the two ledgers.
    expect(ledger[0]!.ref).toBe(sends[0]!.send_id);

    // One mail, one recipient, and the subject the list's own header asked for.
    const sent = await outbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([{ address: `leave-monthly@${HOST}` }]);
    expect(sent[0]!.cc).toEqual([]);
    expect(sent[0]!.bcc).toEqual([]);
    expect(sent[0]!.subject).toBe('unsubscribe');
    expect(sent[0]!.idempotencyKey).toBe(`${await onlyDraftId()}:1`);

    // NO LETTER. The right-click IS the authorisation, and asking again for something already clicked is
    // how a console teaches people to stop reading letters.
    expect(await mailLetterCount()).toBe(0);

    // And the event the console subscribes to says `mailto`.
    expect(events.map((event) => event.data.status)).toContain('done');
    expect(events[events.length - 1]!.data).toMatchObject({
      accountId: ACCOUNT, messageId: MAILTO_ONLY, method: 'mailto', status: 'done',
    });
  }, 40_000);

  it('carries the verdict into every later read, as a `done` and not as an attempt', async () => {
    await unsubscribe(MAILTO_ONLY);
    const until = Date.now() + 15_000;
    let mine: { unsubscribe?: Record<string, unknown> } | undefined;
    while (Date.now() < until) {
      const page = await api<{ messages: Array<{ messageId: string; unsubscribe?: Record<string, unknown> }> }>(
        'GET', `/messages?account=${encodeURIComponent(ACCOUNT)}&mailbox=INBOX&limit=10`,
      );
      mine = page.body.messages.find((message) => message.messageId === MAILTO_ONLY);
      if (mine?.unsubscribe && 'done' in mine.unsubscribe) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(mine!.unsubscribe).toMatchObject({
      available: 'mailto',
      done: { method: 'mailto', scope: 'message' },
    });
    expect(mine!.unsubscribe).not.toHaveProperty('attempt');
  }, 40_000);
});

describe('two clicks on one message', () => {
  it('lets one through and answers the other 409 in-flight, with exactly one request', async () => {
    routes.set('/u/one-click', { status: 200, body: 'ok', hang: true });
    const first = unsubscribe(ONE_CLICK);
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await unsubscribe(ONE_CLICK);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('in-flight');
    expect(second.body.unsubscribe).toMatchObject({ status: 'in-flight', messageId: ONE_CLICK });
    expect(second.body.message).toContain('already unsubscribing');

    release('ok');
    expect((await first).body).toMatchObject({ status: 'done' });
    expect(seen).toHaveLength(1);
  }, 30_000);

  it('answers 409 already, naming the day, once the human is off the list', async () => {
    routes.set('/u/one-click', { status: 200, body: 'ok' });
    await unsubscribe(ONE_CLICK);
    const again = await unsubscribe(ONE_CLICK);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already');
    expect(again.body.message).toMatch(/already unsubscribed from this list on \d{4}-\d{2}-\d{2}/);
    expect(seen).toHaveLength(1);
  });

  it('reclaims a row a killed process left in flight after sixty seconds', async () => {
    routes.set('/u/one-click', { status: 200, body: 'ok' });
    // Exactly the row a process that died mid-attempt leaves behind, aged past the window.
    await runSql(
      'INSERT INTO unsubscribes (account_id, message_id, list_key, method, status, at)'
      + " VALUES (?, ?, ?, 'one-click', 'in-flight', ?)",
      [ACCOUNT, ONE_CLICK, `weekly.${HOST}`, Date.now() - 61_000],
    );
    const answered = await unsubscribe(ONE_CLICK);
    expect(answered.body).toMatchObject({ status: 'done' });
    expect(await rows('SELECT status FROM unsubscribes')).toEqual([{ status: 'done' }]);
  });

  it('refuses while that same row is still fresh', async () => {
    await runSql(
      'INSERT INTO unsubscribes (account_id, message_id, list_key, method, status, at)'
      + " VALUES (?, ?, ?, 'one-click', 'in-flight', ?)",
      [ACCOUNT, ONE_CLICK, `weekly.${HOST}`, Date.now() - 5_000],
    );
    const answered = await unsubscribe(ONE_CLICK);
    expect(answered.status).toBe(409);
    expect(answered.body.error).toBe('in-flight');
    expect(seen).toEqual([]);
  });
});

describe('a page that accepts and never answers', () => {
  it('answers inside its budget, keeps /health fast, and still records the verdict', async () => {
    routes.set('/u/one-click', { hang: true });
    const started = Date.now();
    const pending = unsubscribe(ONE_CLICK);
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    // The event loop is free while the ladder waits. One pinned response is one of the browser's six
    // connections gone, and six of those is an app that looks broken.
    for (let probe = 0; probe < 3; probe += 1) {
      const at = Date.now();
      const health = await api<{ ok: boolean }>('GET', '/health');
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);
      expect(Date.now() - at).toBeLessThan(200);
    }

    const answered = await pending;
    const took = Date.now() - started;
    expect(took).toBeLessThan(15_000);
    // Two ten-second clocks race here and BOTH answers are honest: the route's own budget (202, the
    // ladder keeps going and settles its row) or the ladder's deadline (a failed/timeout verdict).
    expect([200, 202]).toContain(answered.status);
    if (answered.status === 202) expect(answered.body).toMatchObject({ status: 'in-flight' });
    else expect(answered.body).toMatchObject({ status: 'failed', reason: 'timeout' });

    // Either way the ledger ends up holding the verdict rather than a row stuck in flight.
    const until = Date.now() + 15_000;
    let settled: Array<{ status: string; reason: string | null }> = [];
    while (Date.now() < until) {
      settled = await rows<{ status: string; reason: string | null }>('SELECT status, reason FROM unsubscribes');
      if (settled[0]?.status !== 'in-flight') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(settled[0]).toMatchObject({ status: 'failed', reason: 'timeout' });
    release('ok');
  }, 60_000);
});
