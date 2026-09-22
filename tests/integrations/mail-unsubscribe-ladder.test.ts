/**
 * The whole ladder against a REAL socket and the REAL plugin database.
 *
 * What is real here: `http.createServer` on loopback answering real bytes, the worker-thread SQLite
 * with its real migrations (so the v8 upsert's WHERE clause is graded by SQLite and not by a fake),
 * the body store on a temp directory, and the guard.
 *
 * What is injected, and why it is not a bypass: the guard refuses loopback by design, so the test
 * cannot point a public url at 127.0.0.1 by weakening the rule. Instead the TRANSPORT maps the
 * public-looking host to the local port and the RESOLVER answers with a public address — the guard
 * still runs every check on `https://lists.example.invalid/...`, still re-runs on every redirect, and
 * still refuses everything it is supposed to refuse (that half is pinned in the guard's own test).
 * There is deliberately no flag anywhere that turns it off.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailServiceError } from '../../src/integrations/mail/contract.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { MailEvents } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import type { UnsubscribeRow } from '../../src/integrations/mail/store-write.js';
import { MailUnsubscribe, UNSUBSCRIBE_RECLAIM_MS } from '../../src/integrations/mail/unsubscribe.js';
import type { UnsubscribeHttpSeam } from '../../src/integrations/mail/unsubscribe-http.js';
import type {
  MailBody,
  MailCapabilities,
  MailEnvelope,
  MailListUnsubscribe,
  MailProviderSpec,
} from '../../src/integrations/mail/types.js';

const CAPABILITIES: MailCapabilities = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: false, sendAsReply: false, bodies: 'both', attachments: 'none',
};

const ACCOUNT = 'listy:acct-1';
const HOST = 'lists.example.invalid';
const SENT_AT = Date.UTC(2026, 8, 21, 16, 0, 0);

/** One request the local server saw, as the test asserts on it. */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Hold the response open until `release()` is called. For the deadline case. */
  hang?: boolean;
}

interface Harness {
  root: string;
  store: MailStore;
  service: MailService;
  unsubscribe: MailUnsubscribe;
  events: Array<{ name: string; data: Record<string, unknown> }>;
  seen: Seen[];
  routes: Map<string, Route>;
  /** Wall clock the ladder and the ledger read. Movable, for the reclaim case. */
  clock: { at: number };
  bodyHtml: { current: string };
  release: () => void;
}

const open: MailDatabase[] = [];
const roots: string[] = [];
const servers: http.Server[] = [];

async function openHarness(): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-unsub-ladder-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const providers = new MailProviderRegistry(() => undefined);
  const bodyHtml = { current: '<p>This week in the marina.</p>' };

  const spec: MailProviderSpec = {
    id: 'listy',
    label: 'A fixture list',
    capabilities: { ...CAPABILITIES },
    setup: { fields: [], submit: async () => { throw new Error('by hand'); } },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async (): Promise<MailBody> => ({
      format: 'both',
      text: 'This week in the marina.',
      html: bodyHtml.current,
      bytes: Buffer.byteLength(bodyHtml.current),
    }),
    send: async () => ({ acceptedAt: Date.now() }),
  };
  providers.register(spec, 'the-fixture-plugin');

  const seen: Seen[] = [];
  const routes = new Map<string, Route>();
  const held: http.ServerResponse[] = [];
  const server = http.createServer((request, response) => {
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
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const clock = { at: Date.UTC(2026, 8, 22, 9, 0, 0) };
  const seam: Partial<UnsubscribeHttpSeam> = {
    // The guard has already passed `url` at this point, and it is a public https url. The socket is
    // the only thing redirected: `https://lists.example.invalid/x` reaches the local server as
    // `http://127.0.0.1:<port>/x`.
    fetch: (url, init) => fetch(url.replace(`https://${HOST}`, `http://127.0.0.1:${port}`), init),
    lookup: async (hostname) => {
      if (hostname === HOST) return [{ address: '203.0.113.10', family: 4 }];
      throw new Error(`ENOTFOUND ${hostname}`);
    },
  };

  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const mailEvents = new MailEvents((name, data) => {
    events.push({ name, data: data as Record<string, unknown> });
  });
  const service = new MailService({ store, bodies, providers, log: { info: vi.fn(), debug: vi.fn() } });
  const unsubscribe = new MailUnsubscribe({
    store,
    service,
    events: mailEvents,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    now: () => clock.at,
    http: seam,
  });

  await store.upsertAccount({
    accountId: ACCOUNT,
    providerId: 'listy',
    displayName: 'A mailbox',
    address: 'reader@example.invalid',
    state: 'active',
    healthJson: null,
    payload: '{}',
  });

  return {
    root, store, service, unsubscribe, events, seen, routes, clock, bodyHtml,
    release: () => {
      for (const response of held.splice(0)) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('You have been unsubscribed.');
      }
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function listing(over: Partial<MailEnvelope> & { uid?: number } = {}): MailEnvelope {
  const { uid = 42, ...rest } = over;
  return {
    messageId: `INBOX:9001:${uid}`,
    rfcMessageId: `<weekly-${uid}@lists.example.invalid>`,
    mailboxId: 'INBOX',
    from: { name: 'Marina Weekly', address: 'weekly@lists.example.invalid' },
    to: [{ address: 'reader@example.invalid' }],
    subject: `Marina Weekly, issue ${uid}`,
    snippet: 'This week in the marina',
    sentAt: SENT_AT + uid,
    receivedAt: SENT_AT + uid,
    flags: [],
    attachments: [],
    ...rest,
  };
}

function headers(over: Partial<MailListUnsubscribe> = {}): MailListUnsubscribe {
  return {
    https: [`https://${HOST}/u/abc`],
    oneClick: true,
    listId: 'weekly.lists.example.invalid',
    ...over,
  };
}

async function ledgerRow(one: Harness, messageId: string): Promise<UnsubscribeRow | undefined> {
  return one.store.write.getUnsubscribe(ACCOUNT, messageId);
}

const SUCCESS_PAGE = '<html><body><p>You have been unsubscribed from this list.</p></body></html>';

describe('the one-click rung', () => {
  it('posts exactly the RFC 8058 body once, with no cookie, and records done', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 200, body: 'ok' });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);

    const outcome = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    expect(outcome).toMatchObject({ status: 'done', method: 'one-click' });
    expect(outcome.message).toContain('Unsubscribed');

    expect(one.seen).toHaveLength(1);
    expect(one.seen[0]).toMatchObject({ method: 'POST', url: '/u/abc', body: 'List-Unsubscribe=One-Click' });
    expect(one.seen[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(one.seen[0]!.headers['user-agent']).toMatch(/^Walnut\//);
    expect(one.seen[0]!.headers.cookie).toBeUndefined();
    expect(one.seen[0]!.headers.authorization).toBeUndefined();
    expect(one.seen[0]!.headers.referer).toBeUndefined();

    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({
      status: 'done',
      method: 'one-click',
      list_key: 'weekly.lists.example.invalid',
      at: one.clock.at,
    });
    expect(one.events).toEqual([{
      name: 'unsubscribed',
      data: {
        accountId: ACCOUNT,
        messageId: 'INBOX:9001:42',
        listKey: 'weekly.lists.example.invalid',
        method: 'one-click',
        status: 'done',
      },
    }]);
  });

  it('falls through to the GET on the same url when the POST answers 500, and the ledger names both', async () => {
    const one = await openHarness();
    let calls = 0;
    const server = servers[servers.length - 1]!;
    server.removeAllListeners('request');
    server.on('request', (request, response) => {
      // The request body has to be drained even when it is ignored, or the client sees the socket
      // close mid-write and reports a transport error instead of the 500 this test is about.
      request.resume();
      request.on('end', () => {
        calls += 1;
        one.seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: '' });
        if (request.method === 'POST') { response.writeHead(500); response.end('boom'); return; }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(SUCCESS_PAGE);
      });
    });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);

    const outcome = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    expect(outcome).toMatchObject({ status: 'done', method: 'link' });
    expect(calls).toBe(2);
    expect(one.seen.map((seen) => seen.method)).toEqual(['POST', 'GET']);
    // The ledger records the rung that ACTUALLY did it, not the one the claim started on: the console
    // prints that word, and "unsubscribed via one-click" would be the wrong story here.
    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({ status: 'done', method: 'link' });
  });

  it('records the 500 in the detail when the GET rung cannot finish it either', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 500, body: 'boom' });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);

    const outcome = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    expect(outcome.status).toBe('failed');
    // The whole attempt, not just its last step: somebody reading this row needs both.
    expect(outcome.detail).toContain('one-click');
    expect(outcome.detail).toContain('500');
    const row = await ledgerRow(one, 'INBOX:9001:42');
    expect(row).toMatchObject({ status: 'failed', reason: 'unreachable' });
    expect(row!.detail).toContain('500');
  });
});

describe('the GET rung reads the page', () => {
  async function runLink(page: Route): Promise<{ one: Harness; outcome: Awaited<ReturnType<MailUnsubscribe['run']>> }> {
    const one = await openHarness();
    one.routes.set('/u/abc', page);
    await one.service.ingestPage(ACCOUNT, [listing({
      listUnsubscribe: headers({ oneClick: false }),
    })]);
    const outcome = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    return { one, outcome };
  }

  it('a success page is done', async () => {
    const { one, outcome } = await runLink({ status: 200, body: SUCCESS_PAGE });
    expect(outcome).toMatchObject({ status: 'done', method: 'link' });
    expect(one.seen[0]!.method).toBe('GET');
    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({ status: 'done', method: 'link' });
  });

  it('a confirmation form is needs-human, and hands the url back', async () => {
    const { one, outcome } = await runLink({
      status: 200,
      body: '<p>Confirm you want to leave.</p><form action="/unsubscribe"><button>Yes</button></form>',
    });
    expect(outcome).toMatchObject({
      status: 'needs-human',
      reason: 'confirm-form',
      url: `https://${HOST}/u/abc`,
    });
    expect(outcome.message).toContain('confirmation');
    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({
      status: 'needs-human', reason: 'confirm-form',
    });
  });

  it('a marketing homepage is unclear, never a silent success', async () => {
    const { one, outcome } = await runLink({
      status: 200,
      body: '<h1>The Marina Company</h1><p>Boats and moorings since 1998.</p>',
    });
    expect(outcome).toMatchObject({ status: 'needs-human', reason: 'unclear' });
    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({ status: 'needs-human', reason: 'unclear' });
  });

  it('a 403 is failed, named by its code', async () => {
    const { one, outcome } = await runLink({ status: 403, body: 'nope' });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'http-403' });
    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({ status: 'failed', reason: 'http-403' });
  });

  it('follows three real redirects and stops at the fourth', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 302, headers: { location: `https://${HOST}/h1` } });
    one.routes.set('/h1', { status: 302, headers: { location: `https://${HOST}/h2` } });
    one.routes.set('/h2', { status: 302, headers: { location: `https://${HOST}/h3` } });
    one.routes.set('/h3', { status: 200, body: SUCCESS_PAGE });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);
    expect(await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42')).toMatchObject({ status: 'done' });
    expect(one.seen.map((seen) => seen.url)).toEqual(['/u/abc', '/h1', '/h2', '/h3']);

    const deeper = await openHarness();
    deeper.routes.set('/u/abc', { status: 302, headers: { location: `https://${HOST}/h1` } });
    deeper.routes.set('/h1', { status: 302, headers: { location: `https://${HOST}/h2` } });
    deeper.routes.set('/h2', { status: 302, headers: { location: `https://${HOST}/h3` } });
    deeper.routes.set('/h3', { status: 302, headers: { location: `https://${HOST}/h4` } });
    deeper.routes.set('/h4', { status: 200, body: SUCCESS_PAGE });
    await deeper.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);
    const outcome = await deeper.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    expect(outcome).toMatchObject({ status: 'failed', reason: 'too-many-redirects' });
    expect(deeper.seen).toHaveLength(4);
  });

  it('refuses a redirect into the private network at that hop, and the ledger says so', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 302, headers: { location: 'https://192.168.1.5/finish' } });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);
    const outcome = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    expect(outcome).toMatchObject({ status: 'failed', reason: 'blocked-host' });
    expect(one.seen).toHaveLength(1);
    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({ status: 'failed', reason: 'blocked-host' });
  });
});

describe('the link found in the body, for mail whose headers say nothing', () => {
  it('is what a transport with no headers at all gets to use', async () => {
    const one = await openHarness();
    one.bodyHtml.current =
      `<p>Issue 42.</p><p><a href="https://${HOST}/footer/u?t=zz">Unsubscribe</a></p>`;
    one.routes.set('/footer/u?t=zz', { status: 200, body: SUCCESS_PAGE });
    await one.service.ingestPage(ACCOUNT, [listing()]);

    // Before the body is fetched there is nothing to offer, which is honest.
    await expect(one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42')).rejects.toThrow(MailServiceError);

    const read = await one.service.readMessage(ACCOUNT, 'INBOX:9001:42');
    expect(read.message.unsubscribe).toEqual({ available: 'link' });

    const outcome = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    expect(outcome).toMatchObject({ status: 'done', method: 'link' });
    expect(one.seen[0]!.url).toBe('/footer/u?t=zz');
    // With no `List-Id` the ledger keys on the sender, and the console's wording follows that.
    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({
      status: 'done', list_key: 'weekly@lists.example.invalid',
    });
  });
});

describe('the mailto rung is S8 and says so', () => {
  it('answers needs-human with a reason rather than throwing, so the route stays total', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({
      listUnsubscribe: { mailto: ['mailto:leave@lists.example.invalid'], oneClick: false },
    })]);
    const outcome = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    expect(outcome).toMatchObject({ status: 'needs-human', method: 'mailto', reason: 'mailto-pending' });
    expect(outcome.message).toContain('by mail');
    // Nothing left the machine: this rung has no socket at all yet.
    expect(one.seen).toEqual([]);
    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({
      status: 'needs-human', method: 'mailto', reason: 'mailto-pending',
    });
  });
});

describe('what the ladder refuses to be asked', () => {
  it('answers 409 unsupported, with a printable sentence, when there is no way out', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing()]);
    await expect(one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42')).rejects.toMatchObject({
      code: 'unsupported',
      status: 409,
      message: expect.stringContaining('no unsubscribe link'),
    });
    expect(await ledgerRow(one, 'INBOX:9001:42')).toBeUndefined();
    expect(one.seen).toEqual([]);
  });

  it('answers 400 for a rung this message does not have', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    await expect(one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42', { method: 'mailto' }))
      .rejects.toMatchObject({ code: 'invalid', status: 400 });
    await expect(one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42', { method: 'nonsense' }))
      .rejects.toMatchObject({ code: 'invalid', status: 400 });
    expect(one.seen).toEqual([]);
  });

  it('runs only the rung that was asked for', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 500 });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    const outcome = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42', { method: 'link' });
    expect(outcome.method).toBe('link');
    expect(one.seen.map((seen) => seen.method)).toEqual(['GET']);
  });

  it('404s a message the cache has never heard of', async () => {
    const one = await openHarness();
    await expect(one.unsubscribe.run(ACCOUNT, 'INBOX:9001:999'))
      .rejects.toMatchObject({ code: 'unknown_message', status: 404 });
  });
});

describe('one attempt in flight, and nothing that retries itself', () => {
  it('lets one of two simultaneous clicks through and refuses the other', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 200, body: SUCCESS_PAGE, hang: true });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);

    const first = one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    // Wait until the first attempt is really on the wire before the second click lands.
    while (one.seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    expect(second).toMatchObject({ status: 'conflict', conflict: 'in-flight' });
    expect(second.ledger).toMatchObject({ status: 'in-flight' });
    expect(second.message).toContain('already unsubscribing');

    one.release();
    expect(await first).toMatchObject({ status: 'done' });
    // EXACTLY ONE request: the refusal never reached the network.
    expect(one.seen).toHaveLength(1);
  });

  it('refuses a click on a message already unsubscribed, and says when', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 200, body: SUCCESS_PAGE });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);
    expect(await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42')).toMatchObject({ status: 'done' });

    one.clock.at += 5 * 60_000;
    const again = await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    expect(again).toMatchObject({ status: 'conflict', conflict: 'already' });
    expect(again.message).toContain('already unsubscribed from this list');
    // A done row is never re-claimed however old it is, so still exactly one request.
    expect(one.seen).toHaveLength(1);
  });

  it('lets a human retry a failed attempt immediately', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 403 });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);
    expect(await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42')).toMatchObject({ status: 'failed' });

    one.routes.set('/u/abc', { status: 200, body: SUCCESS_PAGE });
    expect(await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42')).toMatchObject({ status: 'done' });
    expect(one.seen).toHaveLength(2);
  });

  it('lets a human retry a needs-human attempt immediately', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 200, body: '<h1>Boats</h1>' });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);
    expect(await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42')).toMatchObject({ status: 'needs-human' });
    one.routes.set('/u/abc', { status: 200, body: SUCCESS_PAGE });
    expect(await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42')).toMatchObject({ status: 'done' });
  });

  it('reclaims a row a killed process left in flight, but only after the window', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 200, body: SUCCESS_PAGE });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);
    // Exactly what a process that died mid-attempt leaves behind.
    await one.store.write.claimUnsubscribe({
      accountId: ACCOUNT,
      messageId: 'INBOX:9001:42',
      listKey: 'weekly.lists.example.invalid',
      method: 'link',
      now: one.clock.at,
      reclaimBefore: one.clock.at - UNSUBSCRIBE_RECLAIM_MS,
    });

    one.clock.at += UNSUBSCRIBE_RECLAIM_MS - 1_000;
    expect(await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42'))
      .toMatchObject({ status: 'conflict', conflict: 'in-flight' });
    expect(one.seen).toEqual([]);

    one.clock.at += 2_000;
    expect(await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42')).toMatchObject({ status: 'done' });
    expect(one.seen).toHaveLength(1);
  });

  it('never lets a late loser overwrite a newer claim', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 200, body: SUCCESS_PAGE, hang: true });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);

    const slow = one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    while (one.seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    // The window passes and somebody else takes the row over while the first attempt is still out.
    one.clock.at += UNSUBSCRIBE_RECLAIM_MS + 1_000;
    await one.store.write.claimUnsubscribe({
      accountId: ACCOUNT,
      messageId: 'INBOX:9001:42',
      listKey: 'weekly.lists.example.invalid',
      method: 'link',
      now: one.clock.at,
      reclaimBefore: one.clock.at - UNSUBSCRIBE_RECLAIM_MS,
    });

    one.release();
    expect(await slow).toMatchObject({ status: 'done' });
    // The row still belongs to the newer claim, and the loser announced nothing.
    expect(await ledgerRow(one, 'INBOX:9001:42')).toMatchObject({ status: 'in-flight' });
    expect(one.events).toEqual([]);
  });
});

describe('what a page of messages learns from the ledger, in one query', () => {
  it('marks the message itself and every other message of the same list', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 200, body: SUCCESS_PAGE });
    await one.service.ingestPage(ACCOUNT, [
      listing({ uid: 42, listUnsubscribe: headers({ oneClick: false }) }),
      listing({ uid: 43, listUnsubscribe: headers({ oneClick: false }) }),
      // Another sender entirely, so it must stay untouched.
      listing({
        uid: 44,
        from: { address: 'other@elsewhere.example.invalid' },
        listUnsubscribe: { https: [`https://${HOST}/other`], oneClick: false, listId: 'other.list' },
      }),
    ]);
    await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');

    const page = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 10 });
    const byId = new Map(page.messages.map((message) => [message.messageId, message]));
    expect(byId.get('INBOX:9001:42')!.unsubscribe).toEqual({
      available: 'link',
      done: { method: 'link', at: one.clock.at, scope: 'message' },
    });
    expect(byId.get('INBOX:9001:43')!.unsubscribe).toEqual({
      available: 'link',
      done: { method: 'link', at: one.clock.at, scope: 'list' },
    });
    expect(byId.get('INBOX:9001:44')!.unsubscribe).toEqual({ available: 'link' });
  });

  it('reports an attempt in flight as pending', async () => {
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 200, body: SUCCESS_PAGE, hang: true });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);
    const running = one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');
    while (one.seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    const page = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 10 });
    expect(page.messages[0]!.unsubscribe).toEqual({ available: 'link', pending: true });
    // And the single-message read says the same thing.
    expect((await one.service.readEnvelope(ACCOUNT, 'INBOX:9001:42')).unsubscribe)
      .toEqual({ available: 'link', pending: true });

    one.release();
    await running;
  });

  it('says nothing at all about a page with an empty ledger', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    const page = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 10 });
    expect(page.messages[0]!.unsubscribe).toEqual({ available: 'one-click' });
  });

  it('can say "you left this list" about a message that captured nothing itself', async () => {
    // The old row nobody ever opened: no headers, so no `available`, but the SENDER is the key and the
    // human has already left. A console that said nothing here would offer to unsubscribe twice.
    const one = await openHarness();
    one.routes.set('/u/abc', { status: 200, body: SUCCESS_PAGE });
    await one.service.ingestPage(ACCOUNT, [
      listing({ uid: 42, listUnsubscribe: { https: [`https://${HOST}/u/abc`], oneClick: false } }),
      listing({ uid: 43 }),
    ]);
    await one.unsubscribe.run(ACCOUNT, 'INBOX:9001:42');

    const page = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 10 });
    const older = page.messages.find((message) => message.messageId === 'INBOX:9001:43')!;
    expect(older.unsubscribe).toEqual({
      available: 'none',
      done: { method: 'link', at: one.clock.at, scope: 'list' },
    });
  });
});
