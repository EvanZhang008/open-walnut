/**
 * The background refresher of first-paint views (src/core/history-ready-refresh.ts).
 *
 * Every seam is a fake: no daemon, no bus, no session store, no file. What it pins:
 *   - a turn's refresh is debounced per session, and skipped when a view READ after that turn is
 *     kept (the meta's contentAt); a view only written after it (a slow answer to an older ask)
 *     does not count, nor does a view an older Walnut wrote (no contentAt);
 *   - a host that comes back has EVERY recent session compared, in batches, with no cap, and only
 *     the changed ones fetched, one at a time;
 *   - a failed batch ends the pass (the next connect starts over), a daemon without the
 *     capability is never asked, one pass per host runs at a time;
 *   - nothing runs during the startup delay or under memory pressure, and stop() ends it all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HistoryReadyRefresher, type HistoryReadyRefreshOptions } from '../../src/core/history-ready-refresh.js';
import { HISTORY_READY_CAPABILITY, type ReadyViewConnection } from '../../src/core/history-ready-view.js';
import type { HistoryViewMeta } from '../../src/core/history-view-snapshot.js';
import type { SessionRecord } from '../../src/core/types.js';
import fs from 'node:fs';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
beforeEach(() => vi.useFakeTimers());
async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await advance(5);
  }
}
const rec = (sid: string, over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ claudeSessionId: sid, host: 'remote-dev', cwd: '/w', ...over }) as SessionRecord;

interface Harness {
  refresher: HistoryReadyRefresher;
  fetched: Array<{ sid: string; have?: string }>;
  turn: (sid: string) => void;
  host: (key: string) => void;
  maxInFlight: () => number;
}

let live: HistoryReadyRefresher[] = [];
afterEach(() => { for (const r of live) r.stop(); live = []; vi.useRealTimers(); });

function harness(over: Partial<HistoryReadyRefreshOptions> & { records?: Map<string, SessionRecord>; metas?: Map<string, HistoryViewMeta>; fetchMs?: number } = {}): Harness {
  const records = over.records ?? new Map<string, SessionRecord>();
  const metas = over.metas ?? new Map<string, HistoryViewMeta>();
  const fetched: Harness['fetched'] = [];
  let inFlight = 0;
  let max = 0;
  let onTurn: (sid: string) => void = () => {};
  let onHost: (key: string) => void = () => {};
  const refresher = new HistoryReadyRefresher({
    turnDebounceMs: 5,
    startupDelayMs: 0,
    paceMs: 1,
    getRecord: async (sid) => records.get(sid) ?? null,
    readMeta: async (sid) => metas.get(sid) ?? null,
    fetch: async (record, have) => {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, over.fetchMs ?? 1));
      fetched.push({ sid: record.claudeSessionId, ...(have ? { have } : {}) });
      inFlight--;
      return undefined;
    },
    connectionFor: () => null,
    listRecentOnHost: async () => [],
    isAcpJournal: () => false,
    subscribeTurns: (cb) => { onTurn = cb; return () => { onTurn = () => {}; }; },
    subscribeHosts: (cb) => { onHost = cb; return () => { onHost = () => {}; }; },
    shedding: () => false,
    ...over,
  });
  live.push(refresher);
  refresher.start();
  return { refresher, fetched, turn: (sid) => onTurn(sid), host: (key) => onHost(key), maxInFlight: () => max };
}

function keysConn(answer: (sids: string[], call: number) => Record<string, string | null> | Error, caps = [HISTORY_READY_CAPABILITY]) {
  const calls: Array<Array<Record<string, unknown>>> = [];
  const conn: ReadyViewConnection = {
    hasCapability: (c) => caps.includes(c),
    send: async (cmd, params) => {
      expect(cmd).toBe('history.readyKeys');
      const items = params.items as Array<Record<string, unknown>>;
      calls.push(items);
      const out = answer(items.map((i) => i.sid as string), calls.length);
      if (out instanceof Error) throw out;
      return { ok: true, keys: out };
    },
  };
  return { conn, calls };
}

describe('after a turn', () => {
  it('a burst of turn ends is one refresh, with the key of the view held', async () => {
    const records = new Map([['s1', rec('s1')]]);
    const metas = new Map([['s1', { savedAt: new Date(0).toISOString(), readyKey: 'old-key' }]]);
    const h = harness({ records, metas });
    h.turn('s1'); h.turn('s1'); h.turn('s1');
    await waitFor(() => h.fetched.length > 0);
    await advance(30);
    expect(h.fetched).toEqual([{ sid: 's1', have: 'old-key' }]);
  });

  it('skips a session whose view was read after that turn', async () => {
    const records = new Map([['s1', rec('s1')]]);
    const metas = new Map([['s1', { savedAt: new Date(Date.now() + 60_000).toISOString(), contentAt: Date.now() + 60_000 }]]);
    let asked = 0;
    const h = harness({ records, metas, getRecord: async (sid) => { asked++; return records.get(sid) ?? null; } });
    h.turn('s1');
    await waitFor(() => asked > 0);
    await advance(20);
    expect(h.fetched).toEqual([]);
  });

  it('a view WRITTEN after the turn but read before it does not count (the late answer of an older ask)', async () => {
    // The review's order: T1 ends, a refresh for it starts (its read begins); T2 ends; T1's answer
    // is saved after T2 ended. The kept view lacks T2, so T2's refresh must still run.
    const records = new Map([['s1', rec('s1')]]);
    const t1ReadAt = Date.now() - 1_000;
    const metas = new Map<string, HistoryViewMeta>([['s1', { savedAt: new Date(Date.now() + 5_000).toISOString(), readyKey: 'k-t1', contentAt: t1ReadAt }]]);
    const h = harness({ records, metas });
    h.turn('s1'); // T2 ends now, after T1's read began
    await waitFor(() => h.fetched.length > 0);
    expect(h.fetched).toEqual([{ sid: 's1', have: 'k-t1' }]);
  });

  it('a view an older Walnut wrote (no contentAt) never skips a refresh', async () => {
    const records = new Map([['s1', rec('s1')]]);
    const metas = new Map<string, HistoryViewMeta>([['s1', { savedAt: new Date(Date.now() + 60_000).toISOString() }]]);
    const h = harness({ records, metas });
    h.turn('s1');
    await waitFor(() => h.fetched.length > 0);
    expect(h.fetched).toEqual([{ sid: 's1' }]);
  });

  it('a fork, an ACP journal or a gone record is not fetched', async () => {
    const records = new Map([
      ['fork', rec('fork', { forkedFromSessionId: 'parent' })],
      ['acp', rec('acp', { engine: 'some-acp' } as unknown as Partial<SessionRecord>)],
    ]);
    let asked = 0;
    const h = harness({ records, isAcpJournal: (r) => r.claudeSessionId === 'acp', getRecord: async (sid) => { asked++; return records.get(sid) ?? null; } });
    h.turn('fork'); h.turn('acp'); h.turn('gone');
    await waitFor(() => asked >= 3);
    await advance(20);
    expect(h.fetched).toEqual([]);
  });
});

describe('when a host comes back', () => {
  it('compares every recent session in batches with no cap, and fetches the changed ones one at a time', async () => {
    const all = Array.from({ length: 120 }, (_, i) => rec(`r${i}`, i === 7 ? { forkedFromSessionId: 'p' } : {}));
    const records = new Map(all.map((r) => [r.claudeSessionId, r]));
    const metas = new Map(all.map((r, i) => [r.claudeSessionId, { savedAt: new Date(0).toISOString(), readyKey: i % 3 === 0 ? 'stale' : `key-${r.claudeSessionId}` }]));
    const { conn, calls } = keysConn((sids) => Object.fromEntries(sids.map((s) => [s, s === 'r5' ? null : `key-${s}`])));
    let since = '';
    const h = harness({
      records, metas, fetchMs: 2,
      connectionFor: () => conn,
      listRecentOnHost: async (_host, s) => { since = s; return all; },
    });
    const changed = await h.refresher.reconnectPass('remote-dev');
    // 119 eligible (the fork is out): batches of 50, 50, 19.
    expect(calls.map((c) => c.length)).toEqual([50, 50, 19]);
    expect(calls[0]![0]).toMatchObject({ sid: 'r0', cwd: '/w', turns: 10, rows: 400 });
    expect(typeof calls[0]![0]!.legacyHintCutoffMs).toBe('number');
    expect(Date.now() - Date.parse(since)).toBeGreaterThan(6 * 24 * 3600_000);
    const stale = all.filter((r, i) => i % 3 === 0 && r.claudeSessionId !== 'r5' && i !== 7).map((r) => r.claudeSessionId);
    expect(changed).toBe(stale.length);
    await waitFor(() => h.fetched.length === stale.length, 5000);
    expect(h.fetched.map((f) => f.sid)).toEqual(stale);
    expect(h.maxInFlight()).toBe(1);
  });

  it('compares a rewound session with the same cut fields the fetch sends', async () => {
    const cut = { uuid: 'u2', lastUuidAtCommit: 'a3', at: '2026-01-01T00:00:00Z', trailingQueueKeys: ['q1'] };
    const all = [rec('cut1', { inPlaceRewinds: [cut] })];
    const { conn, calls } = keysConn((sids) => Object.fromEntries(sids.map((s) => [s, 'k'])));
    const h = harness({ records: new Map(all.map((r) => [r.claudeSessionId, r])), connectionFor: () => conn, listRecentOnHost: async () => all });
    await h.refresher.reconnectPass('remote-dev');
    expect(calls[0]![0]!.cuts).toEqual([{ uuid: 'u2', lastUuidAtCommit: 'a3', trailingQueueKeys: ['q1'] }]);
  });

  it('a failed batch ends the pass', async () => {
    const all = Array.from({ length: 120 }, (_, i) => rec(`f${i}`));
    const { conn, calls } = keysConn((sids, call) => (call === 2 ? new Error('link down') : Object.fromEntries(sids.map((s) => [s, 'new']))));
    const h = harness({ records: new Map(all.map((r) => [r.claudeSessionId, r])), connectionFor: () => conn, listRecentOnHost: async () => all });
    expect(await h.refresher.reconnectPass('remote-dev')).toBe(50);
    expect(calls).toHaveLength(2);
  });

  it('asks no daemon without the capability, and runs one pass per host at a time', async () => {
    let listed = 0;
    const old = keysConn(() => ({}), []);
    const h1 = harness({ connectionFor: () => old.conn, listRecentOnHost: async () => { listed++; return []; } });
    expect(await h1.refresher.reconnectPass('remote-dev')).toBe(0);
    expect(listed).toBe(0);

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const cur = keysConn((sids) => Object.fromEntries(sids.map((s) => [s, 'k'])));
    const h2 = harness({ connectionFor: () => cur.conn, listRecentOnHost: async () => { listed++; await held; return [rec('p1')]; } });
    const first = h2.refresher.reconnectPass('remote-dev');
    expect(await h2.refresher.reconnectPass('remote-dev')).toBe(0);
    release();
    await first;
    expect(listed).toBe(1);
  });

  it('a connect during the startup delay waits for it', async () => {
    let listed = 0;
    const { conn } = keysConn(() => ({}));
    const h = harness({ startupDelayMs: 60, connectionFor: () => conn, listRecentOnHost: async () => { listed++; return []; } });
    h.host('remote-dev');
    h.host('remote-dev');
    await advance(20);
    expect(listed).toBe(0);
    await waitFor(() => listed > 0);
    await advance(80);
    expect(listed).toBe(1);
  });
});

describe('brakes', () => {
  it('the server does not warm copied histories without an explicit isolated-run opt-in', () => {
    const server = fs.readFileSync('src/web/server.ts', 'utf8');
    expect(server).toMatch(/if \(!isEphemeral \|\| process\.env\.WALNUT_HISTORY_READY_REFRESH === '1'\)\s*\{\s*historyReadyRefresher = await/);
  });

  it('nothing is queued under memory pressure, and a queue is dropped when it starts', async () => {
    let shedding = true;
    const records = new Map([['m1', rec('m1')], ['m2', rec('m2')], ['m3', rec('m3')]]);
    const h = harness({ records, fetchMs: 15, shedding: () => shedding });
    h.refresher.enqueue({ sessionId: 'm1', after: 0 });
    expect(h.refresher._queueLength()).toBe(0);
    shedding = false;
    h.refresher.enqueue({ sessionId: 'm1', after: 0 });
    h.refresher.enqueue({ sessionId: 'm2', after: 0 });
    h.refresher.enqueue({ sessionId: 'm3', after: 0 });
    await advance(5);
    shedding = true;
    await advance(60);
    expect(h.fetched.map((f) => f.sid)).toEqual(['m1']);
    expect(h.refresher._queueLength()).toBe(0);
  });

  it('a session queued twice keeps one place', async () => {
    const records = new Map([['d1', rec('d1')], ['d2', rec('d2')]]);
    const h = harness({ records, fetchMs: 10 });
    h.refresher.enqueue({ sessionId: 'd1', after: 0 });
    h.refresher.enqueue({ sessionId: 'd2', after: 0 });
    h.refresher.enqueue({ sessionId: 'd2', after: 0 });
    await waitFor(() => h.fetched.length >= 2);
    await advance(30);
    expect(h.fetched.map((f) => f.sid)).toEqual(['d1', 'd2']);
  });

  it('stop() drops the queue and the timers', async () => {
    const records = new Map([['x1', rec('x1')], ['x2', rec('x2')]]);
    const h = harness({ records, fetchMs: 20 });
    h.refresher.enqueue({ sessionId: 'x1', after: 0 });
    h.refresher.enqueue({ sessionId: 'x2', after: 0 });
    h.turn('x2');
    await advance(5);
    h.refresher.stop();
    await advance(60);
    expect(h.fetched.map((f) => f.sid)).toEqual(['x1']);
    h.refresher.enqueue({ sessionId: 'x2', after: 0 });
    expect(h.refresher._queueLength()).toBe(0);
  });
});
