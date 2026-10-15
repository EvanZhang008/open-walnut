/**
 * The web client mints one op id per user action that writes
 * (docs/plan/walnut-replica-servers-impl.md, section 3, "Op ids"; WP2): every
 * HTTP write carries `x-walnut-op-id`, a read carries none, and every WS RPC
 * frame carries `opId`. A host replica keeps the id when it forwards or
 * journals the write, so the Mac applies the action once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from '../../web/src/api/client';
import { mintOpId, isWriteMethod, withOpId, OP_ID_HEADER, WAIT_HEADER } from '../../web/src/api/op-id';
import fs from 'node:fs';
import path from 'node:path';

/** The server's own check of a client op id (src/replica/dispatch.ts ensureOpId). */
const SERVER_ACCEPTS = /^[A-Za-z0-9_-]{6,80}$/;

describe('op ids on HTTP writes', () => {
  let calls: Array<{ url: string; method: string; headers: Record<string, string> }>;

  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: { ...(init.headers as Record<string, string>) } });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('each write gets its own id, in the shape the replica keeps; a read gets none', async () => {
    await apiPost('/api/tasks', { title: 'Acme' });
    await apiPatch('/api/tasks/t1', { title: 'Acme 2' });
    await apiPut('/api/ui-prefs', { a: 1 });
    await apiDelete('/api/tasks/t1');
    await apiGet('/api/tasks');
    const ids = calls.slice(0, 4).map((c) => c.headers[OP_ID_HEADER]);
    for (const id of ids) expect(id).toMatch(SERVER_ACCEPTS);
    expect(new Set(ids).size).toBe(4);
    expect(calls[4]!.headers[OP_ID_HEADER]).toBeUndefined();
  });

  it('a write that waits longer than 15 s says how long (the replica\'s forward budget); others and reads say nothing', async () => {
    await apiPatch('/api/calendar/events/e1', { start: 'a', end: 'b', human_confirm: true }, { timeoutMs: 180_000 });
    await apiPost('/api/tasks', { title: 'Acme' });
    await apiGet('/api/tasks', undefined, { timeoutMs: 60_000 });
    expect(calls[0]!.headers[WAIT_HEADER]).toBe('180000');
    expect(calls[1]!.headers[WAIT_HEADER]).toBeUndefined();
    expect(calls[2]!.headers[WAIT_HEADER]).toBeUndefined();
  });

  it('mintOpId is op- and 16 hex digits; only writing methods carry one', () => {
    expect(mintOpId()).toMatch(/^op-[0-9a-f]{16}$/);
    expect(isWriteMethod('post')).toBe(true);
    expect(isWriteMethod('DELETE')).toBe(true);
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(isWriteMethod(m)).toBe(false);
  });
});

describe('op ids on WS RPC frames', () => {
  let sent: string[];
  let fakeSocket: Record<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    sent = [];
    fakeSocket = { readyState: 1, send: (b: string) => { sent.push(b); }, close: () => {}, onopen: null, onclose: null, onerror: null, onmessage: null };
    const FakeWebSocket = function () { return fakeSocket; } as unknown as typeof WebSocket;
    (FakeWebSocket as unknown as { OPEN: number }).OPEN = 1;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost:3456' } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('every frame carries its own op id, also one queued until the socket opened', async () => {
    const { wsClient } = await import('@/api/ws');
    fakeSocket.readyState = 0;
    void wsClient.sendRpc('session:send', { sessionId: 's1', text: 'queued' }).catch(() => {});
    wsClient.connect();
    fakeSocket.readyState = 1;
    (fakeSocket as { onopen?: () => void }).onopen?.();
    void wsClient.sendRpc('session:send', { sessionId: 's1', text: 'hello' }).catch(() => {});
    const frames = sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'req' && f.method === 'session:send');
    expect(frames.map((f) => f.payload.text).sort()).toEqual(['hello', 'queued']);
    for (const f of frames) expect(f.opId).toMatch(SERVER_ACCEPTS);
    expect(new Set(frames.map((f) => f.opId)).size).toBe(2);
  });
});

describe('raw fetch writes (not through request())', () => {
  const ORIGIN = 'https://marina.example';

  it('a same-origin write gets an op id; a read, another origin, and a write that has one are left alone', () => {
    const save = withOpId('/api/file-content', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }, ORIGIN);
    const h = new Headers(save!.headers);
    expect(h.get(OP_ID_HEADER)).toMatch(SERVER_ACCEPTS);
    expect(h.get('content-type')).toBe('application/json');
    expect(save!.body).toBe('{}');
    expect(new Headers(withOpId(`${ORIGIN}/api/files/duplicate`, { method: 'post' }, ORIGIN)!.headers).get(OP_ID_HEADER)).toMatch(SERVER_ACCEPTS);
    const read = { headers: { a: '1' } };
    expect(withOpId('/api/tasks', read, ORIGIN)).toBe(read);
    expect(withOpId('/api/tasks', undefined, ORIGIN)).toBeUndefined();
    const other = { method: 'POST' };
    expect(withOpId('https://acme.example/hook', other, ORIGIN)).toBe(other);
    expect(withOpId('//acme.example/hook', other, ORIGIN)).toBe(other);
    const own = { method: 'POST', headers: { [OP_ID_HEADER]: 'op-kept-000001' } };
    expect(withOpId('/api/tasks', own, ORIGIN)).toBe(own);
  });

  it('each raw write is its own action: two calls, two ids', () => {
    const a = new Headers(withOpId('/api/files/rename', { method: 'POST' }, ORIGIN)!.headers).get(OP_ID_HEADER);
    const b = new Headers(withOpId('/api/files/rename', { method: 'POST' }, ORIGIN)!.headers).get(OP_ID_HEADER);
    expect(a).not.toBe(b);
  });

  it('a Request object keeps its own headers and gains the id', () => {
    const req = new Request(`${ORIGIN}/api/stt/recordings`, { method: 'POST', headers: { 'X-Acme': 'yes' } });
    const h = new Headers(withOpId(req, undefined, ORIGIN)!.headers);
    expect(h.get('x-acme')).toBe('yes');
    expect(h.get(OP_ID_HEADER)).toMatch(SERVER_ACCEPTS);
  });

  it('the boot installs it before anything else sends a write (web/src/main.tsx)', () => {
    const main = fs.readFileSync(path.join(__dirname, '../../web/src/main.tsx'), 'utf8');
    const install = main.indexOf('installOpIdFetch();');
    expect(install).toBeGreaterThan(0);
    for (const first of ['consumePairFragment();', 'installOpenLinks();', 'initBrowserLogger();', 'initUiPrefsSync(']) {
      const at = main.indexOf(first);
      if (at >= 0) expect(install).toBeLessThan(at);
    }
  });
});
