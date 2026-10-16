/**
 * Client op ids on the write routes (docs/plan/walnut-replica-servers-impl.md section 3,
 * "Op ids"), against the REAL applied-ops ledger (a temp sqlite file) and a real HTTP
 * server, so the in-flight case runs over two real sockets:
 *   - a write with an op id applies once; a duplicate gets the first answer again;
 *   - a duplicate sent while the first is still in its handler waits and gets the
 *     first answer (also when the first client aborted, the web client's retry);
 *   - a 5xx is not kept: the retry may apply;
 *   - x-walnut-forwarded-at older than 20 s on this server's clock (judged with the
 *     host's measured offset) answers 409 stale_forward and applies nothing; with no
 *     offset known for that host it is never refused on age;
 *   - the key carries the host: the same id from two hosts applies twice.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { opIdMiddleware, stampArrival, tagForwardedSocket, STALE_FORWARD_MS } from '../../../src/web/middleware/op-id.js';
import { _setLedgerFileForTesting, lookupApplied, recordApplied, LOCAL_HOST } from '../../../src/core/offline-merge/ledger.js';
import { _resetHostClocksForTesting, _setHostClockForTesting } from '../../../src/core/offline-merge/host-clock.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-op-id-'));
const HOME = '/data/walnut-marina';

let applied: Array<{ id: string; body: unknown }> = [];
/** Resolves a held handler (the "still in its handler" case). */
let release: (() => void) | null = null;
let hold = false;
let failNext = 0;
let server: Server;
let base = '';
let clock = 1_000_000_000_000;

function app(opts: Parameters<typeof opIdMiddleware>[0] = {}): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/api', opIdMiddleware({ home: HOME, now: () => clock, ...opts }));
  a.post('/api/tasks/:id', async (req, res) => {
    if (hold) await new Promise<void>((r) => { release = r; });
    if (failNext > 0) { failNext--; res.status(500).json({ error: 'disk hiccup' }); return; }
    applied.push({ id: req.params.id, body: req.body });
    res.status(201).json({ ok: true, n: applied.length });
  });
  a.get('/api/tasks/:id', (_req, res) => { res.json({ read: true }); });
  return a;
}

async function listen(a: express.Express, onConn?: (s: import('node:net').Socket) => void): Promise<void> {
  server = a.listen(0, '127.0.0.1');
  if (onConn) server.on('connection', onConn);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(p: string, headers: Record<string, string>, body: unknown = { title: 'Acme' }, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
}

beforeEach(() => {
  _setLedgerFileForTesting(path.join(tmp, `ledger-${Math.random().toString(16).slice(2)}.sqlite`));
  _resetHostClocksForTesting();
  applied = [];
  hold = false;
  release = null;
  failNext = 0;
});

afterEach(async () => {
  release?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server?.closeAllConnections?.();
});

afterAll(() => {
  _setLedgerFileForTesting(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('op id middleware', () => {
  it('applies a write once; a duplicate gets the first answer, marked replayed', async () => {
    await listen(app());
    const a = await post('/api/tasks/t1', { 'x-walnut-op-id': 'op-0123456789abcdef' });
    expect(a.status).toBe(201);
    expect(await a.json()).toEqual({ ok: true, n: 1 });
    const b = await post('/api/tasks/t1', { 'x-walnut-op-id': 'op-0123456789abcdef' }, { title: 'something else' });
    expect(b.status).toBe(201);
    expect(b.headers.get('x-walnut-op-replayed')).toBe('1');
    expect(await b.json()).toEqual({ ok: true, n: 1 });
    expect(applied).toHaveLength(1);
    expect(lookupApplied({ hostKey: LOCAL_HOST, home: HOME, opId: 'op-0123456789abcdef', rev: 1 }, clock)?.status).toBe(201);
  });

  it('two requests with the same op id, the second sent while the first is still in its handler, apply once and both get the first answer', async () => {
    await listen(app());
    hold = true;
    const first = post('/api/tasks/t2', { 'x-walnut-op-id': 'op-inflight-1' });
    await until(() => release !== null);
    const second = post('/api/tasks/t2', { 'x-walnut-op-id': 'op-inflight-1' });
    await new Promise((r) => setTimeout(r, 100));
    expect(applied).toHaveLength(0);
    hold = false;
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await a.json()).toEqual({ ok: true, n: 1 });
    expect(await b.json()).toEqual({ ok: true, n: 1 });
    expect(applied).toHaveLength(1);
  });

  it('a client that aborted and retried 300 ms later gets the first attempt answer when its handler ends', async () => {
    await listen(app());
    hold = true;
    const ac = new AbortController();
    const first = post('/api/tasks/t3', { 'x-walnut-op-id': 'op-abort-1' }, { title: 'x' }, ac.signal).catch((e: unknown) => e);
    await until(() => release !== null);
    ac.abort();
    await first;
    await new Promise((r) => setTimeout(r, 300));
    const retry = post('/api/tasks/t3', { 'x-walnut-op-id': 'op-abort-1' });
    await new Promise((r) => setTimeout(r, 100));
    hold = false;
    release!();
    const b = await retry;
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual({ ok: true, n: 1 });
    expect(applied).toHaveLength(1);
  });

  it('a 5xx is not kept: the retry with the same id applies', async () => {
    await listen(app());
    failNext = 1;
    const a = await post('/api/tasks/t4', { 'x-walnut-op-id': 'op-retry-500' });
    expect(a.status).toBe(500);
    const b = await post('/api/tasks/t4', { 'x-walnut-op-id': 'op-retry-500' });
    expect(b.status).toBe(201);
    expect(b.headers.get('x-walnut-op-replayed')).toBeNull();
    expect(applied).toHaveLength(1);
  });

  it('a refusal (4xx) is the answer a duplicate gets again', async () => {
    const a = express();
    let calls = 0;
    a.use(express.json());
    a.use('/api', opIdMiddleware({ home: HOME }));
    a.post('/api/boards/b1', (_req, res) => { calls++; res.status(409).json({ error: { code: 'subtask_too_deep' } }); });
    await listen(a);
    const r1 = await post('/api/boards/b1', { 'x-walnut-op-id': 'op-refused' });
    const r2 = await post('/api/boards/b1', { 'x-walnut-op-id': 'op-refused' });
    expect([r1.status, r2.status]).toEqual([409, 409]);
    expect(await r2.json()).toEqual({ error: { code: 'subtask_too_deep' } });
    expect(calls).toBe(1);
  });

  it('reads and writes without an op id pass through untouched; a malformed id is refused', async () => {
    await listen(app());
    expect((await fetch(`${base}/api/tasks/t5`, { headers: { 'x-walnut-op-id': 'op-get' } })).status).toBe(200);
    await post('/api/tasks/t5', {});
    await post('/api/tasks/t5', {});
    expect(applied).toHaveLength(2);
    const bad = await post('/api/tasks/t5', { 'x-walnut-op-id': 'op id with spaces' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('bad_op_id');
    expect(applied).toHaveLength(2);
  });
});

describe('forwarded writes', () => {
  const hostOf = (req: express.Request): string => String(req.headers['x-test-host'] ?? LOCAL_HOST);

  it('a forwarded write older than 20 s on this server clock answers 409 stale_forward, applies nothing, and is not remembered', async () => {
    await listen(app({ hostKeyOf: hostOf }));
    _setHostClockForTesting('marina', 0);
    const old = await post('/api/tasks/t6', { 'x-test-host': 'marina', 'x-walnut-op-id': 'op-stale-1', 'x-walnut-forwarded-at': String(clock - STALE_FORWARD_MS - 1) });
    expect(old.status).toBe(409);
    const body = (await old.json()) as { error: { code: string; ageMs: number } };
    expect(body.error.code).toBe('stale_forward');
    expect(body.error.ageMs).toBe(STALE_FORWARD_MS + 1);
    expect(applied).toHaveLength(0);
    // The journaled retry of the same action (or a fresh forward) applies: the refusal kept nothing.
    expect(lookupApplied({ hostKey: 'marina', home: HOME, opId: 'op-stale-1', rev: 1 }, clock)).toBeNull();
    const fresh = await post('/api/tasks/t6', { 'x-test-host': 'marina', 'x-walnut-op-id': 'op-stale-1', 'x-walnut-forwarded-at': String(clock - 1000) });
    expect(fresh.status).toBe(201);
    expect(applied).toHaveLength(1);
  });

  it('the age is judged with the host measured offset: a host clock 60 s behind is not stale, one 60 s ahead is', async () => {
    await listen(app({ hostKeyOf: hostOf }));
    // offset = macNow - hostNow: the host runs 60 s behind the Mac.
    _setHostClockForTesting('marina', 60_000);
    const behind = await post('/api/tasks/t7', { 'x-test-host': 'marina', 'x-walnut-op-id': 'op-skew-1', 'x-walnut-forwarded-at': String(clock - 60_000 - 5_000) });
    expect(behind.status).toBe(201);
    _setHostClockForTesting('acme', -60_000);
    const ahead = await post('/api/tasks/t7', { 'x-test-host': 'acme', 'x-walnut-op-id': 'op-skew-2', 'x-walnut-forwarded-at': String(clock + 60_000 - 25_000) });
    expect(ahead.status).toBe(409);
    expect(applied).toHaveLength(1);
  });

  it('with no measured offset for that host a forwarded write is never refused on age (the ledger still dedupes)', async () => {
    await listen(app({ hostKeyOf: hostOf }));
    const ancient = { 'x-test-host': 'marina', 'x-walnut-op-id': 'op-nooffset', 'x-walnut-forwarded-at': String(clock - 3_600_000) };
    expect((await post('/api/tasks/t8', ancient)).status).toBe(201);
    const again = await post('/api/tasks/t8', ancient);
    expect(again.status).toBe(201);
    expect(again.headers.get('x-walnut-op-replayed')).toBe('1');
    expect(applied).toHaveLength(1);
  });

  it('the key carries the host: the same op id through two hosts applies on each, once', async () => {
    await listen(app({ hostKeyOf: hostOf }));
    for (const host of ['marina', 'acme', 'marina', 'acme']) {
      expect((await post('/api/tasks/t9', { 'x-test-host': host, 'x-walnut-op-id': 'v1-0123456789abcdef' })).status).toBe(201);
    }
    expect(applied).toHaveLength(2);
  });

  it('the host comes from the forward lane tag on the socket, never from a header', async () => {
    let n = 0;
    // The first connection is a forward lane for host marina; the second is this Mac's browser.
    await listen(app(), (s) => { if (n++ === 0) tagForwardedSocket(s, 'marina'); });
    const viaLane = await fetch(`${base}/api/tasks/t10`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-op-id': 'op-tag-1', connection: 'close' }, body: '{}' });
    expect(viaLane.status).toBe(201);
    expect(lookupApplied({ hostKey: 'marina', home: HOME, opId: 'op-tag-1', rev: 1 }, clock)).not.toBeNull();
    const local = await fetch(`${base}/api/tasks/t10`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-walnut-op-id': 'op-tag-1', 'x-test-host': 'marina', connection: 'close' }, body: '{}' });
    expect(local.status).toBe(201);
    expect(local.headers.get('x-walnut-op-replayed')).toBeNull();
    expect(lookupApplied({ hostKey: LOCAL_HOST, home: HOME, opId: 'op-tag-1', rev: 1 }, clock)).not.toBeNull();
    expect(applied).toHaveLength(2);
  });

  it('the ledger survives a restart of this server (the file is reopened)', async () => {
    const file = path.join(tmp, 'restart.sqlite');
    _setLedgerFileForTesting(file);
    await listen(app());
    expect((await post('/api/tasks/t11', { 'x-walnut-op-id': 'op-restart' })).status).toBe(201);
    _setLedgerFileForTesting(file);
    const again = await post('/api/tasks/t11', { 'x-walnut-op-id': 'op-restart' });
    expect(again.headers.get('x-walnut-op-replayed')).toBe('1');
    expect(applied).toHaveLength(1);
  });
});

describe('op ids: review fixes (WP9)', () => {
  const hostOf = (req: express.Request): string => String(req.headers['x-test-host'] ?? LOCAL_HOST);

  it('a stale forward of a write already applied answers the first answer, not "was not applied"', async () => {
    await listen(app({ hostKeyOf: hostOf }));
    _setHostClockForTesting('marina', 0);
    const first = await post('/api/tasks/t20', { 'x-test-host': 'marina', 'x-walnut-op-id': 'op-late-1', 'x-walnut-forwarded-at': String(clock) });
    expect(first.status).toBe(201);
    clock += 30_000;
    const late = await post('/api/tasks/t20', { 'x-test-host': 'marina', 'x-walnut-op-id': 'op-late-1', 'x-walnut-forwarded-at': String(clock - 25_000) });
    expect(late.status).toBe(201);
    expect(late.headers.get('x-walnut-op-replayed')).toBe('1');
    expect(applied).toHaveLength(1);
  });

  it('the same op id on another route is refused 409 op_id_reused and that route never runs', async () => {
    const a = app();
    let started = 0;
    a.post('/api/other/:id/start', (_req, res) => { started++; res.json({ started: true }); });
    await listen(a);
    expect((await post('/api/tasks/t21', { 'x-walnut-op-id': 'op-reuse-1' })).status).toBe(201);
    const other = await post('/api/other/t21/start', { 'x-walnut-op-id': 'op-reuse-1' });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe('op_id_reused');
    expect(started).toBe(0);
    // The same route again is still the ordinary duplicate.
    expect((await post('/api/tasks/t21', { 'x-walnut-op-id': 'op-reuse-1' })).headers.get('x-walnut-op-replayed')).toBe('1');
  });

  it('an answer that carries a credential is never stored; a duplicate gets its status and a short body', async () => {
    const a = app();
    a.post('/api/devices/pair', (_req, res) => { res.status(201).json({ token: 'tok-live-bearer-0001', pairingURI: 'walnut://pair?t=tok-live-bearer-0001' }); });
    await listen(a);
    const first = await post('/api/devices/pair', { 'x-walnut-op-id': 'op-pair-1' });
    expect(((await first.json()) as { token: string }).token).toBe('tok-live-bearer-0001');
    const row = lookupApplied({ hostKey: LOCAL_HOST, home: HOME, opId: 'op-pair-1', rev: 1 }, clock);
    expect(row).toMatchObject({ outcome: 'applied', status: 201 });
    expect(row?.body).toBeUndefined();
    const dup = await post('/api/devices/pair', { 'x-walnut-op-id': 'op-pair-1' });
    expect(dup.status).toBe(201);
    expect(await dup.text()).not.toContain('tok-live-bearer');
  });

  it('the ledger file is owner-only', async () => {
    const file = path.join(tmp, 'mode.sqlite');
    _setLedgerFileForTesting(file);
    await listen(app());
    expect((await post('/api/tasks/t22', { 'x-walnut-op-id': 'op-mode-1' })).status).toBe(201);
    // The file exists once the ledger opened; reopening applies the mode to it.
    _setLedgerFileForTesting(file);
    expect(lookupApplied({ hostKey: LOCAL_HOST, home: HOME, opId: 'op-mode-1', rev: 1 }, clock)).not.toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('op ids: re-review fixes (WP9 round 1)', () => {
  it('a forward whose body took 25 s to arrive is judged from when its headers arrived, not refused stale', async () => {
    const a = express();
    a.use(stampArrival(() => clock));
    // The body streams in over a slow link: the clock moves on before the parser is done.
    a.use((_req, _res, next) => { clock += 25_000; next(); });
    a.use(express.json());
    a.use('/api', opIdMiddleware({ home: HOME, now: () => clock, hostKeyOf: () => 'marina' }));
    a.post('/api/tasks/:id', (req, res) => { applied.push({ id: req.params.id, body: req.body }); res.status(201).json({ ok: true }); });
    await listen(a);
    _setHostClockForTesting('marina', 0);
    const res = await post('/api/tasks/t-slow', { 'x-walnut-op-id': 'op-slow-body-1', 'x-walnut-forwarded-at': String(clock - 1_000) });
    expect(res.status).toBe(201);
    expect(applied).toHaveLength(1);
    // Headers that themselves arrived 21 s after the replica opened the stream are still stale.
    const late = await post('/api/tasks/t-slow', { 'x-walnut-op-id': 'op-slow-body-2', 'x-walnut-forwarded-at': String(clock - STALE_FORWARD_MS - 1_000) });
    expect(late.status).toBe(409);
    expect(applied).toHaveLength(1);
  });

  it('a retry of a write the drain refused or gave up (no HTTP answer stored) is answered 409, never 200', async () => {
    await listen(app());
    recordApplied({ hostKey: LOCAL_HOST, home: HOME, opId: 'op-drain-refused', rev: 1 }, { outcome: 'refused', detail: 'device no longer paired', source: 'drain' }, clock);
    recordApplied({ hostKey: LOCAL_HOST, home: HOME, opId: 'op-drain-gaveup', rev: 1 }, { outcome: 'given-up', detail: 'three failures', source: 'drain' }, clock);
    recordApplied({ hostKey: LOCAL_HOST, home: HOME, opId: 'op-drain-applied', rev: 1 }, { outcome: 'applied', source: 'drain' }, clock);
    const refused = await post('/api/tasks/t-r', { 'x-walnut-op-id': 'op-drain-refused' });
    expect(refused.status).toBe(409);
    expect(refused.ok).toBe(false);
    expect(((await refused.json()) as { ok: boolean; error: { message: string } })).toMatchObject({ ok: false, error: { message: 'device no longer paired' } });
    expect((await post('/api/tasks/t-r', { 'x-walnut-op-id': 'op-drain-gaveup' })).status).toBe(409);
    const ok = await post('/api/tasks/t-r', { 'x-walnut-op-id': 'op-drain-applied' });
    expect(ok.status).toBe(200);
    expect(applied).toHaveLength(0);
  });
});

describe('op ids: re-review fixes (WP9 round 2)', () => {
  const hostOf = (req: express.Request): string => String(req.headers['x-test-host'] ?? LOCAL_HOST);

  it("a direct write from this server's own client after a host drain applied the same op (any rev) answers that apply; the handler never runs", async () => {
    await listen(app({ hostKeyOf: hostOf }));
    // The client sent the action through a replica (journaled, the drain applied it as rev 2),
    // then retried it straight at this Mac.
    recordApplied({ hostKey: 'marina', home: HOME, opId: 'op-drained-1', rev: 2 }, { outcome: 'applied', source: 'drain' }, clock);
    const direct = await post('/api/tasks/t-d', { 'x-walnut-op-id': 'op-drained-1' });
    expect(direct.status).toBe(200);
    expect(direct.headers.get('x-walnut-op-replayed')).toBe('1');
    // A tagged forward from that host finds its own drain row too.
    expect((await post('/api/tasks/t-d', { 'x-test-host': 'marina', 'x-walnut-op-id': 'op-drained-1' })).status).toBe(200);
    expect(applied).toHaveLength(0);
    // Another host's forward is its own key: a drain row of marina never answers it.
    expect((await post('/api/tasks/t-d', { 'x-test-host': 'acme-box', 'x-walnut-op-id': 'op-drained-1' })).status).toBe(201);
    expect(applied).toHaveLength(1);
  });

  it('a stale copy of a write whose first copy is still running waits for that answer, never 409 stale_forward', async () => {
    await listen(app({ hostKeyOf: hostOf }));
    _setHostClockForTesting('marina', 0);
    hold = true;
    const first = post('/api/tasks/t-s', { 'x-test-host': 'marina', 'x-walnut-op-id': 'op-stale-running', 'x-walnut-forwarded-at': String(clock - 1000) });
    await until(() => release !== null);
    const late = post('/api/tasks/t-s', { 'x-test-host': 'marina', 'x-walnut-op-id': 'op-stale-running', 'x-walnut-forwarded-at': String(clock - STALE_FORWARD_MS - 5000) });
    await new Promise((r) => setTimeout(r, 100));
    hold = false;
    release!();
    const [a, b] = await Promise.all([first, late]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await b.json()).toEqual({ ok: true, n: 1 });
    expect(applied).toHaveLength(1);
  });
});
