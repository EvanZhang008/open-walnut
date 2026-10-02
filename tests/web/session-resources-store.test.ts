/**
 * The browser's copy of what each session costs its machine
 * (web/src/stores/session-resources-store.ts): frames keyed by host, a session
 * index for the column header, pushes that never go backwards, hydration on
 * the first subscriber and on reconnect, and the three availability answers.
 * The WS singleton and the API are faked at the module boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostResourceFrame, ResourcesRead } from '@/api/resources';

const api = vi.hoisted(() => ({
  fetchResources: vi.fn<(opts?: Record<string, unknown>) => Promise<ResourcesRead | null>>(),
}));
const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    handlers,
    wsClient: {
      onEvent(name: string, cb: (data: unknown) => void) {
        let set = handlers.get(name);
        if (!set) { set = new Set(); handlers.set(name, set); }
        set.add(cb);
      },
      offEvent() {},
    },
    emit(name: string, data: unknown) { for (const cb of handlers.get(name) ?? []) cb(data); },
  };
});
vi.mock('@/api/resources', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }));

import {
  _resetResourcesStoreForTest, getResourceFrames, getResourcesAvailability, getSessionResourceRow,
  hydrateResources, subscribeResources, upsertResourceFrame,
} from '@/stores/session-resources-store';

function frame(host: string, at: number, sessions: Array<{ sid: string; rss: number; heavy?: boolean; sessionId?: string; history?: Array<{ at: number; rssBytes: number }> }>): HostResourceFrame {
  return {
    host, at, ok: true, processCount: 10,
    sessions: sessions.map((s) => ({
      sid: s.sid, kind: 'cli', rootPid: 1, alive: true, procCount: 1, rssBytes: s.rss, cpuPct: null, top: [], known: true, heavy: s.heavy ?? false,
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
      ...(s.history ? { history: s.history.map((p) => ({ ...p, cpuPct: null })) } : {}),
    })),
    totals: { sessions: sessions.length, rssBytes: sessions.reduce((a, s) => a + s.rss, 0), cpuPct: null },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetResourcesStoreForTest();
  api.fetchResources.mockReset();
});

describe('session-resources-store', () => {
  it('the first subscriber hydrates; the frames sort local first and index every session', async () => {
    api.fetchResources.mockResolvedValue({ watching: false, hosts: [frame('zeta', 5, [{ sid: 'z1', rss: 1 }]), frame('__local__', 5, [{ sid: 'l1', rss: 2 }, { sid: 'l2', rss: 3, heavy: true }])] });
    const seen: number[] = [];
    const off = subscribeResources(() => seen.push(getResourceFrames().length));
    await flush();
    expect(api.fetchResources).toHaveBeenCalledTimes(1);
    expect(getResourceFrames().map((f) => f.host)).toEqual(['__local__', 'zeta']);
    expect(getSessionResourceRow('l2')).toMatchObject({ host: '__local__', row: { heavy: true } });
    expect(getSessionResourceRow('z1')?.host).toBe('zeta');
    expect(getSessionResourceRow('nope')).toBeNull();
    expect(getResourcesAvailability()).toBe('available');
    expect(seen.length).toBeGreaterThan(0);
    off();
  });

  it('a push replaces a host frame and the session index; an older push is ignored', () => {
    expect(upsertResourceFrame(frame('__local__', 10, [{ sid: 'a', rss: 1 }]))).toBe(true);
    ws.emit('session:resources', frame('__local__', 20, [{ sid: 'b', rss: 2 }]));
    expect(getSessionResourceRow('a')).toBeNull();
    expect(getSessionResourceRow('b')?.row.rssBytes).toBe(2);
    ws.emit('session:resources', frame('__local__', 15, [{ sid: 'a', rss: 1 }]));
    expect(getSessionResourceRow('b')?.row.rssBytes).toBe(2);
    expect(getResourcesAvailability()).toBe('available');
    // Junk never lands.
    expect(upsertResourceFrame({ host: 'x' } as unknown as HostResourceFrame)).toBe(false);
    ws.emit('session:resources', null);
    expect(getResourceFrames()).toHaveLength(1);
  });

  it('the snapshot identity is stable between changes (useSyncExternalStore contract)', async () => {
    api.fetchResources.mockResolvedValue({ watching: false, hosts: [frame('__local__', 1, [{ sid: 'a', rss: 1 }])] });
    await hydrateResources({ force: true });
    const a = getResourceFrames();
    expect(getResourceFrames()).toBe(a);
    expect(getSessionResourceRow('a')).toBe(getSessionResourceRow('a'));
    ws.emit('session:resources', frame('__local__', 2, [{ sid: 'a', rss: 5 }]));
    expect(getResourceFrames()).not.toBe(a);
  });

  it('a fresh read bypasses the TTL, a plain read inside it is skipped, and a host gone from the read is dropped', async () => {
    api.fetchResources.mockResolvedValue({ watching: true, hosts: [frame('__local__', 1, []), frame('dev', 1, [])] });
    await hydrateResources({ force: true });
    await hydrateResources();
    expect(api.fetchResources).toHaveBeenCalledTimes(1);
    api.fetchResources.mockResolvedValue({ watching: true, hosts: [frame('__local__', 2, [])] });
    await hydrateResources({ fresh: true, history: true });
    expect(api.fetchResources).toHaveBeenCalledTimes(2);
    expect(api.fetchResources).toHaveBeenLastCalledWith({ fresh: true, history: true });
    expect(getResourceFrames().map((f) => f.host)).toEqual(['__local__']);
  });

  it('204 means sampling is off here; 404 means an older server; both are said once and stop the asking', async () => {
    api.fetchResources.mockResolvedValue(null);
    await hydrateResources({ force: true });
    expect(getResourcesAvailability()).toBe('off');
    expect(getResourceFrames()).toEqual([]);
    _resetResourcesStoreForTest();
    api.fetchResources.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    await hydrateResources({ force: true });
    expect(getResourcesAvailability()).toBe('unsupported');
  });

  it('a reconnect re-reads (pushes missed while away are gone for good)', async () => {
    api.fetchResources.mockResolvedValue({ watching: false, hosts: [] });
    ws.emit('_ws:reconnected', undefined);
    await flush();
    expect(api.fetchResources).toHaveBeenCalledTimes(1);
  });

  it('concurrent hydrates share one request', async () => {
    let resolve!: (v: ResourcesRead) => void;
    api.fetchResources.mockReturnValue(new Promise((r) => { resolve = r; }));
    const p1 = hydrateResources({ fresh: true });
    const p2 = hydrateResources({ fresh: true });
    resolve({ watching: true, hosts: [] });
    await Promise.all([p1, p2]);
    expect(api.fetchResources).toHaveBeenCalledTimes(1);
  });

  it('a stronger ask during a weaker read waits for it and then asks for itself; a covered one shares it', async () => {
    let resolveFirst!: (v: ResourcesRead) => void;
    api.fetchResources.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));
    api.fetchResources.mockResolvedValue({ watching: true, hosts: [] });
    const plain = hydrateResources();
    const watched = hydrateResources({ fresh: true, history: true, watch: true });
    const covered = hydrateResources();
    resolveFirst({ watching: false, hosts: [] });
    await Promise.all([plain, watched, covered]);
    expect(api.fetchResources.mock.calls.map((c) => c[0])).toEqual([
      { fresh: undefined, history: undefined, watch: undefined },
      { fresh: true, history: true, watch: true },
    ]);
  });

  it('an older read that lost the race to a push still lends the push its history', () => {
    ws.emit('session:resources', frame('__local__', 20, [{ sid: 'a', rss: 2 }]));
    expect(upsertResourceFrame(frame('__local__', 15, [{ sid: 'a', rss: 1, history: [{ at: 10, rssBytes: 1 }, { at: 15, rssBytes: 1 }] }]))).toBe(true);
    const row = getSessionResourceRow('a')!.row;
    expect(row.rssBytes).toBe(2);
    expect(row.history?.map((p) => [p.at, p.rssBytes])).toEqual([[10, 1], [15, 1], [20, 2]]);
    // An older frame with nothing to lend changes nothing.
    expect(upsertResourceFrame(frame('__local__', 16, [{ sid: 'a', rss: 9 }]))).toBe(false);
  });

  it('a stale frame (the newest sample failed) keeps the rows but adds no sparkline point', () => {
    upsertResourceFrame(frame('__local__', 10, [{ sid: 'a', rss: 1, history: [{ at: 10, rssBytes: 1 }] }]));
    ws.emit('session:resources', { ...frame('__local__', 40, [{ sid: 'a', rss: 1 }]), stale: true, reason: 'error', error: 'timeout' });
    expect(getSessionResourceRow('a')?.row.history?.map((p) => p.at)).toEqual([10]);
  });

  it('an ACP row is found by its Walnut session id, not by the runtime id the daemon reports', () => {
    upsertResourceFrame(frame('__local__', 1, [{ sid: 'runtime-7', sessionId: 'walnut-session-7', rss: 4 }]));
    expect(getSessionResourceRow('walnut-session-7')?.row.sid).toBe('runtime-7');
    expect(getSessionResourceRow('runtime-7')).toBeNull();
  });

  it('a push keeps the sparkline a read brought and extends it; a push of the same sample adds nothing', () => {
    upsertResourceFrame(frame('__local__', 10, [{ sid: 'a', rss: 1, history: [{ at: 5, rssBytes: 1 }, { at: 10, rssBytes: 1 }] }]));
    // The same sample's push (no history) arrives after the read.
    ws.emit('session:resources', frame('__local__', 10, [{ sid: 'a', rss: 1 }]));
    expect(getSessionResourceRow('a')?.row.history?.map((p) => p.at)).toEqual([5, 10]);
    ws.emit('session:resources', frame('__local__', 15, [{ sid: 'a', rss: 3 }, { sid: 'new', rss: 2 }]));
    expect(getSessionResourceRow('a')?.row.history).toEqual([{ at: 5, rssBytes: 1, cpuPct: null }, { at: 10, rssBytes: 1, cpuPct: null }, { at: 15, rssBytes: 3, cpuPct: null }]);
    // A session the read never saw has no history to keep.
    expect(getSessionResourceRow('new')?.row.history).toBeUndefined();
    // The cap matches the server's 60 points.
    for (let at = 20; at < 400; at += 5) ws.emit('session:resources', frame('__local__', at, [{ sid: 'a', rss: at }]));
    const h = getSessionResourceRow('a')!.row.history!;
    expect(h).toHaveLength(60);
    expect(h[h.length - 1].at).toBe(395);
  });
});
