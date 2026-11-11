/**
 * The server's half of a ready view (src/core/history-ready-view.ts) and the meta it keeps beside
 * each first-paint view (src/core/history-view-snapshot.ts `.meta`).
 *
 * The daemon is a fake connection (no process, no socket); the view store writes only into the
 * mocked WALNUT_HOME temp dir, which afterEach removes.
 *
 * Pinned here:
 *   - only a daemon that advertises 'history-ready-v1' is asked, with the cuts, the server's
 *     legacy-hint cutoff and the key of the view held;
 *   - an answer of another parse schema, another parser version or other rewind cuts is never
 *     kept or shown;
 *   - a readable answer is kept with its key, bound to echo claims, its remote images rewritten,
 *     its in-flight rows marked unsettled; an unreadable one is not kept;
 *   - an answer that comes after a rewind (the generation moved, or the cuts the session holds now
 *     are not the ones the host filtered by) is neither shown nor kept;
 *   - an answer is bounded before it is decoded: base64 size, gunzip output, row shape;
 *   - readyViewWithin never waits past its deadline, and a later answer is still kept, unless a
 *     view from a later read (the route's full fetch) is kept by then, in memory or on disk;
 *   - firstPaintRace: a readable preview never waits for the ready view; an unreadable one waits
 *     for it, bounded by its deadline;
 *   - the `.meta` follows its view: written with it (with when its read began), removed with it,
 *     pruned with it, and a view the route kept clears a ready key the daemon gave an older one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, HISTORY_CACHE_DIR } from '../../src/constants.js';
import {
  fetchReadyView, firstPaintRace, readyViewEligible, readyViewWithin, wireCut, HISTORY_READY_CAPABILITY,
  READY_VIEW_INTERACTIVE_BUDGET_MS, READY_VIEW_BACKGROUND_BUDGET_MS, READY_MAX_ROWS_GZ_B64,
  type ReadyViewConnection, type ReadyViewFetchDeps,
} from '../../src/core/history-ready-view.js';
import {
  _resetHistoryViewsForTesting, flushHistoryViewsForTesting, readHistoryView, readHistoryViewMeta,
  saveHistoryView, deleteHistoryView, historyViewGeneration, beginHistoryViewRead, pruneHistoryViews,
} from '../../src/core/history-view-snapshot.js';
import { HISTORY_PARSER_VERSION } from '../../src/core/history-parser-version.js';
import { HISTORY_CACHE_SCHEMA, rewindCutsKey, type SessionHistoryMessage } from '../../src/core/history-parse.js';
import { legacyHintCutoff } from '../../src/core/sessions/legacy-hint-lines.js';
import { READY_MAX_ROWS } from '../../src/providers/history-ready-core.js';
import type { SessionRecord } from '../../src/core/types.js';

const viewsDir = path.join(HISTORY_CACHE_DIR as string, 'views');

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return { claudeSessionId: 'rv-session', taskId: '', project: 'p', process_status: 'stopped', work_status: 'agent_complete', mode: 'default', startedAt: '', lastActiveAt: '', cwd: '/w', ...over } as SessionRecord;
}
const row = (i: number, extra: Partial<SessionHistoryMessage> = {}): SessionHistoryMessage =>
  ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `row ${i}`, timestamp: '', msgId: `m${i}`, ...extra }) as SessionHistoryMessage;
const gz = (rows: unknown): string => zlib.gzipSync(Buffer.from(JSON.stringify(rows))).toString('base64');
function readyAnswer(rows: SessionHistoryMessage[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, status: 'ready', key: 'key-1', schema: HISTORY_CACHE_SCHEMA, parser: HISTORY_PARSER_VERSION, cutsKey: rewindCutsKey(undefined), rowsGz: gz(rows), rows: rows.length, total: rows.length, windowed: false, complete: true, readable: true, ...over };
}

interface FakeConn extends ReadyViewConnection { calls: Array<{ cmd: string; params: Record<string, unknown>; timeoutMs?: number }> }
function fakeConn(answer: (params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>, caps = [HISTORY_READY_CAPABILITY]): FakeConn {
  const calls: FakeConn['calls'] = [];
  return {
    calls,
    hasCapability: (cap) => caps.includes(cap),
    send: async (cmd, params, timeoutMs) => { calls.push({ cmd, params, timeoutMs }); return await answer(params) as { ok: boolean }; },
  };
}
function deps(conn: ReadyViewConnection | null, over: Partial<ReadyViewFetchDeps> = {}): ReadyViewFetchDeps & { bound: string[]; rewritten: string[] } {
  const bound: string[] = [];
  const rewritten: string[] = [];
  return {
    bound, rewritten,
    connectionFor: () => conn,
    bindEchoClaims: (sid) => { bound.push(sid); },
    rewriteImages: async (rows, host) => { rewritten.push(host); return rows.map((r) => ({ ...r, text: `${r.text} @${host}` })); },
    readCuts: async () => [],
    ...over,
  };
}

beforeEach(async () => {
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  _resetHistoryViewsForTesting();
});
afterEach(async () => {
  _resetHistoryViewsForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('which sessions and which daemons', () => {
  it('a fork or an ACP journal has no ready view', () => {
    expect(readyViewEligible(record(), false)).toBe(true);
    expect(readyViewEligible(record({ forkedFromSessionId: 'parent' }), false)).toBe(false);
    expect(readyViewEligible(record(), true)).toBe(false);
    expect(readyViewEligible(null, false)).toBe(false);
  });

  it('asks no daemon that lacks the capability, and none when there is no connection', async () => {
    const old = fakeConn(() => readyAnswer([row(0)]), []);
    expect(await fetchReadyView(record(), { interactive: true, deps: deps(old) })).toEqual({ kind: 'unavailable', reason: 'no-capability' });
    expect(old.calls).toEqual([]);
    expect(await fetchReadyView(record(), { interactive: true, deps: deps(null) })).toEqual({ kind: 'unavailable', reason: 'no-capability' });
  });

  it('sends the cuts, the cutoff, the held key and the budget of who asks', async () => {
    const cuts = [{ uuid: 'u2', lastUuidAtCommit: 'a3', at: '2026-01-01T00:00:00Z', trailingQueueKeys: ['q1'] }];
    const conn = fakeConn(() => ({ ok: true, status: 'unchanged', key: 'held' }));
    const rec = record({ host: 'remote-dev', inPlaceRewinds: cuts });
    expect(await fetchReadyView(rec, { interactive: true, have: 'held', deps: deps(conn) })).toEqual({ kind: 'unchanged', key: 'held' });
    await fetchReadyView(rec, { interactive: false, deps: deps(conn) });
    const [person, background] = conn.calls;
    expect(person!.cmd).toBe('history.readyView');
    expect(person!.params).toMatchObject({
      sid: 'rv-session', cwd: '/w', turns: 1, rows: 40, have: 'held', interactive: true,
      budgetMs: READY_VIEW_INTERACTIVE_BUDGET_MS, legacyHintCutoffMs: legacyHintCutoff(),
      cuts: [{ uuid: 'u2', lastUuidAtCommit: 'a3', trailingQueueKeys: ['q1'] }],
    });
    expect((person!.params.cuts as Array<Record<string, unknown>>)[0]!.at).toBeUndefined();
    expect(background!.params).toMatchObject({ turns: 10, rows: 400, budgetMs: READY_VIEW_BACKGROUND_BUDGET_MS });
    expect(background!.params.interactive).toBeUndefined();
    expect(background!.params.have).toBeUndefined();
  });

  it('wireCut carries every field the probe replays, and nothing else', () => {
    expect(wireCut({ uuid: 'u', lastUuidAtCommit: 'l', at: 'x', trailingQueueKeys: ['q'] })).toEqual({ uuid: 'u', lastUuidAtCommit: 'l', trailingQueueKeys: ['q'] });
    expect(wireCut({ uuid: 'u', lastUuidAtCommit: 'l', at: 'x' })).toEqual({ uuid: 'u', lastUuidAtCommit: 'l' });
  });
});

describe('an answer', () => {
  it('a readable one is kept with its key, bound, rewritten for a remote host, unsettled rows marked', async () => {
    const inFlight = row(1, { tools: [{ name: 'Agent', toolUseId: 't1', input: { run_in_background: true }, result: 'Async agent launched', status: 'done' }] } as never);
    const conn = fakeConn(() => readyAnswer([row(0), inFlight], { windowed: true, total: 9, finishedAgentIds: ['ag1', 3] }));
    const d = deps(conn);
    const out = await fetchReadyView(record({ host: 'remote-dev' }), { interactive: false, deps: d });
    expect(out.kind).toBe('rows');
    if (out.kind !== 'rows') return;
    expect(out.rows).toMatchObject({ total: 9, windowed: true, readable: true, key: 'key-1', finishedAgentIds: ['ag1'] });
    expect(out.rows.messages.map((m) => m.text)).toEqual(['row 0 @remote-dev', 'row 1 @remote-dev']);
    expect((out.rows.messages[1] as { unsettled?: boolean }).unsettled).toBe(true);
    expect(d.bound).toEqual(['rv-session']);
    expect(d.rewritten).toEqual(['remote-dev']);

    const view = await readHistoryView('rv-session');
    expect(view).toMatchObject({ total: 9, windowed: true, readyKey: 'key-1', origin: 'ready', finishedAgentIds: ['ag1'] });
    expect(await readHistoryViewMeta('rv-session')).toMatchObject({ readyKey: 'key-1' });
  });

  it('a newer interactive screen is served but never replaces the fuller background view', async () => {
    const rows = [row(0), row(1), row(2)];
    saveHistoryView('rv-session', { messages: rows, total: 3 }, beginHistoryViewRead('rv-session', Date.now() - 1000));
    const out = await fetchReadyView(record(), { interactive: true, deps: deps(fakeConn(() => readyAnswer([row(2)]))) });
    expect(out.kind).toBe('rows');
    expect((await readHistoryView('rv-session'))?.messages).toEqual(rows);
  });

  it('a local session keeps its image paths', async () => {
    const d = deps(fakeConn(() => readyAnswer([row(0)])));
    const out = await fetchReadyView(record(), { interactive: true, deps: d });
    expect(out.kind === 'rows' && out.rows.messages[0]!.text).toBe('row 0');
    expect(d.rewritten).toEqual([]);
  });

  it('another schema, another parser, other cuts or a broken payload is never kept', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [readyAnswer([row(0)], { schema: HISTORY_CACHE_SCHEMA + 1 }), 'schema'],
      // A daemon on an older build: same schema, another parser.
      [readyAnswer([row(0)], { parser: '0000000000000000' }), 'parser'],
      [readyAnswer([row(0)], { parser: undefined }), 'parser'],
      [readyAnswer([row(0)], { cutsKey: 'u9>x9' }), 'cuts'],
      [readyAnswer([row(0)], { rowsGz: 'bm90IGd6aXA=' }), 'malformed'],
      [readyAnswer([row(0)], { rowsGz: gz({ not: 'rows' }) }), 'malformed'],
      [{ ok: true, status: 'pending', reason: 'building' }, 'pending:building'],
      [{ ok: false, error: 'boom' }, 'boom'],
    ];
    for (const [answer, reason] of cases) {
      const out = await fetchReadyView(record(), { interactive: true, deps: deps(fakeConn(() => answer)) });
      expect(out).toEqual({ kind: 'unavailable', reason });
    }
    const thrown = await fetchReadyView(record(), { interactive: true, deps: deps(fakeConn(() => { throw new Error('link down'); })) });
    expect(thrown).toEqual({ kind: 'unavailable', reason: 'link down' });
    expect(await readHistoryView('rv-session')).toBeNull();
  });

  it('a rewound session takes only an answer made with its own cuts', async () => {
    const cuts = [{ uuid: 'u2', lastUuidAtCommit: 'a3', at: '' }];
    const rec = record({ inPlaceRewinds: cuts });
    const ok = await fetchReadyView(rec, { interactive: true, deps: deps(fakeConn(() => readyAnswer([row(0)], { cutsKey: rewindCutsKey(cuts) })), { readCuts: async () => cuts }) });
    expect(ok.kind).toBe('rows');
    const unfiltered = await fetchReadyView(rec, { interactive: true, deps: deps(fakeConn(() => readyAnswer([row(0)])), { readCuts: async () => cuts }) });
    expect(unfiltered).toEqual({ kind: 'unavailable', reason: 'cuts' });
  });

  it('an unreadable one is answered but not kept', async () => {
    const out = await fetchReadyView(record(), { interactive: true, deps: deps(fakeConn(() => readyAnswer([row(0)], { readable: false }))) });
    expect(out.kind === 'rows' && out.rows.readable).toBe(false);
    expect(await readHistoryView('rv-session')).toBeNull();
  });

  it('one that comes after a rewind deleted the view is not kept', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const conn = fakeConn(async () => { await held; return readyAnswer([row(0)]); });
    const fetching = fetchReadyView(record(), { interactive: false, deps: deps(conn) });
    await new Promise((r) => setTimeout(r, 10));
    await deleteHistoryView('rv-session');
    release();
    // Not kept, and not shown either: the rows may hold the branch the rewind cut.
    expect(await fetching).toEqual({ kind: 'unavailable', reason: 'rewound' });
    expect(await readHistoryView('rv-session')).toBeNull();
  });

  it('a cut recorded while the host worked: the unfiltered rows are neither shown nor kept', async () => {
    // The route read the record before the rewind was recorded, so it asked with no cuts.
    const cutsNow = [{ uuid: 'u2', lastUuidAtCommit: 'a3', at: '' }];
    const out = await fetchReadyView(record(), { interactive: true, deps: deps(fakeConn(() => readyAnswer([row(0)])), { readCuts: async () => cutsNow }) });
    expect(out).toEqual({ kind: 'unavailable', reason: 'rewound' });
    const gone = await fetchReadyView(record(), { interactive: true, deps: deps(fakeConn(() => readyAnswer([row(0)])), { readCuts: async () => null }) });
    expect(gone).toEqual({ kind: 'unavailable', reason: 'rewound' });
    expect(await readHistoryView('rv-session')).toBeNull();
  });

  it('bounded before any decode: oversize base64, a gzip that inflates past the cap, rows of the wrong shape', async () => {
    const huge = 'A'.repeat(READY_MAX_ROWS_GZ_B64 + 4);
    // About 3 MiB of JSON from a few KB of gzip.
    const bomb = zlib.gzipSync(Buffer.from(JSON.stringify([{ role: 'user', text: 'x'.repeat(3 * 1024 * 1024), timestamp: '' }]))).toString('base64');
    const cases: Array<[Record<string, unknown>, string]> = [
      [readyAnswer([row(0)], { rowsGz: huge }), 'too-large'],
      [readyAnswer([row(0)], { rowsGz: bomb }), 'malformed'],
      [readyAnswer([row(0)], { rowsGz: gz([{ role: 'robot', text: 'a', timestamp: '' }]) }), 'malformed'],
      [readyAnswer([row(0)], { rowsGz: gz([{ role: 'user', timestamp: '' }]) }), 'malformed'],
      [readyAnswer([row(0)], { rowsGz: gz([{ role: 'user', text: 'a', timestamp: 5 }]) }), 'malformed'],
      [readyAnswer([row(0)], { rowsGz: gz(Array.from({ length: READY_MAX_ROWS + 1 }, (_, i) => row(i))) }), 'malformed'],
    ];
    for (const [answer, reason] of cases) {
      expect(await fetchReadyView(record(), { interactive: true, deps: deps(fakeConn(() => answer)) })).toEqual({ kind: 'unavailable', reason });
    }
    expect(bomb.length).toBeLessThan(READY_MAX_ROWS_GZ_B64);
    expect(await readHistoryView('rv-session')).toBeNull();
  });
});

describe('readyViewWithin', () => {
  it('answers rows that come in time', async () => {
    const rows = await readyViewWithin(record(), 500, deps(fakeConn(() => readyAnswer([row(0), row(1)]))));
    expect(rows?.messages).toHaveLength(2);
  });

  it('never waits past its deadline and an interactive screen does not replace a fuller view', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let answered!: () => void;
    const done = new Promise<void>((r) => { answered = r; });
    const conn = fakeConn(async () => { await held; setTimeout(answered, 0); return readyAnswer([row(0)]); });
    const t0 = performance.now();
    expect(await readyViewWithin(record(), 30, deps(conn))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
    expect(await readHistoryView('rv-session')).toBeNull();
    release();
    await done;
    expect(await readHistoryView('rv-session')).toBeNull();
  });

  it('a late answer after a rewind is neither shown nor kept (the generation is taken before the ask)', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const conn = fakeConn(async () => { await held; return readyAnswer([row(0)]); });
    const gen = historyViewGeneration('rv-session');
    const pending = fetchReadyView(record(), { interactive: true, deps: deps(conn) });
    await deleteHistoryView('rv-session');
    expect(historyViewGeneration('rv-session')).toBe(gen + 1);
    release();
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'rewound' });
    expect(await readHistoryView('rv-session')).toBeNull();
  });

  it('a late answer never replaces a view from a later read (memory, then disk after a restart)', async () => {
    for (const restart of [false, true]) {
      _resetHistoryViewsForTesting();
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const conn = fakeConn(async () => { await held; return readyAnswer([row(0)], { key: 'old-key' }); });
      // An older background read is still waiting when the full fetch keeps its newer view.
      const pending = fetchReadyView(record(), {
        interactive: false, read: beginHistoryViewRead('rv-session', 1_000), deps: deps(conn),
      });
      expect(saveHistoryView('rv-session', { messages: [row(0), row(1), row(2)], total: 3 }, beginHistoryViewRead('rv-session', 2_000))).toBe(true);
      await flushHistoryViewsForTesting();
      if (restart) _resetHistoryViewsForTesting(); // memory gone: only the disk meta knows
      release();
      expect((await pending).kind).toBe('rows');
      await flushHistoryViewsForTesting();
      _resetHistoryViewsForTesting();
      const kept = await readHistoryView('rv-session');
      expect(kept?.messages, `restart=${restart}`).toHaveLength(3);
      expect(kept?.readyKey).toBeUndefined();
      expect((await readHistoryViewMeta('rv-session'))?.contentAt).toBe(kept?.contentAt);
    }
  });

  it('an older read loses to a newer one whatever order they are saved in; equal reads keep the later save', () => {
    const sid = 'rv-order';
    const early = beginHistoryViewRead(sid, 1_000);
    const late = beginHistoryViewRead(sid, 2_000);
    expect(saveHistoryView(sid, { messages: [row(0), row(1)], total: 2 }, late)).toBe(true);
    expect(saveHistoryView(sid, { messages: [row(0)], total: 1 }, early)).toBe(false);
    expect(saveHistoryView(sid, { messages: [row(0), row(1), row(2)], total: 3 }, late)).toBe(true);
  });

  it('an unreadable answer in time is no first paint', async () => {
    expect(await readyViewWithin(record(), 500, deps(fakeConn(() => readyAnswer([row(0)], { readable: false }))))).toBeNull();
  });
});

describe('firstPaintRace', () => {
  const later = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
  const readyRows = { messages: [row(0)], total: 1, windowed: false, complete: true, readable: true, key: 'k' };

  it('a readable preview answers at once, never waiting for a slow ready view', async () => {
    const t0 = performance.now();
    const out = await firstPaintRace(later(800, null), later(20, ['readable']), (p) => p.length > 0);
    expect(out).toEqual({ kind: 'preview', preview: ['readable'] });
    expect(performance.now() - t0).toBeLessThan(300);
  });

  it('a ready view that comes first wins', async () => {
    expect(await firstPaintRace(later(5, readyRows), later(200, ['x']), () => true)).toEqual({ kind: 'ready', ready: readyRows });
  });

  it('an unreadable preview waits for the ready view; with none it answers the preview', async () => {
    const t0 = performance.now();
    expect(await firstPaintRace(later(120, readyRows), later(5, [] as string[]), (p) => p.length > 0)).toEqual({ kind: 'ready', ready: readyRows });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100);
    expect(await firstPaintRace(later(30, null), later(5, [] as string[]), (p) => p.length > 0)).toEqual({ kind: 'preview', preview: [] });
    expect(await firstPaintRace(Promise.reject(new Error('link')), later(5, [] as string[]), () => false)).toEqual({ kind: 'preview', preview: [] });
  });

  it('a failed preview waits for the ready view, and fails only without one', async () => {
    const boom = new Error('read failed');
    expect(await firstPaintRace(later(20, readyRows), Promise.reject(boom), () => true)).toEqual({ kind: 'ready', ready: readyRows });
    await expect(firstPaintRace(later(20, null), Promise.reject(boom), () => true)).rejects.toBe(boom);
    await expect(firstPaintRace(null, Promise.reject(boom), () => true)).rejects.toBe(boom);
  });
});

describe('the view meta', () => {
  it('is written beside its view, and a route view clears the ready key', async () => {
    const sid = 'rv-meta';
    saveHistoryView(sid, { messages: [row(0)], total: 1, readyKey: 'k1', origin: 'ready' }, beginHistoryViewRead(sid));
    await flushHistoryViewsForTesting();
    expect(JSON.parse(fs.readFileSync(path.join(viewsDir, `${sid}.meta`), 'utf8'))).toMatchObject({ readyKey: 'k1', contentAt: expect.any(Number) });
    _resetHistoryViewsForTesting();
    expect(await readHistoryViewMeta(sid)).toMatchObject({ readyKey: 'k1' });

    // A key without the ready origin is not kept: only the daemon's own view carries one.
    saveHistoryView(sid, { messages: [row(0), row(1)], total: 2, readyKey: 'forged' }, beginHistoryViewRead(sid));
    expect((await readHistoryViewMeta(sid))?.readyKey).toBeUndefined();
    await flushHistoryViewsForTesting();
    _resetHistoryViewsForTesting();
    expect((await readHistoryViewMeta(sid))?.readyKey).toBeUndefined();
    expect((await readHistoryView(sid))?.messages).toHaveLength(2);
  });

  it('goes with its view: deleted, pruned, and never read for a view that is gone', async () => {
    const sid = 'rv-meta-gone';
    saveHistoryView(sid, { messages: [row(0)], total: 1, readyKey: 'k1', origin: 'ready' }, beginHistoryViewRead(sid));
    await flushHistoryViewsForTesting();
    await deleteHistoryView(sid);
    expect(fs.existsSync(path.join(viewsDir, `${sid}.meta`))).toBe(false);

    const old = 'rv-meta-old';
    saveHistoryView(old, { messages: [row(0)], total: 1, readyKey: 'k2', origin: 'ready' }, beginHistoryViewRead(old));
    await flushHistoryViewsForTesting();
    await pruneHistoryViews({ maxAgeMs: -1 });
    expect(fs.existsSync(path.join(viewsDir, `${old}.json`))).toBe(false);
    expect(fs.existsSync(path.join(viewsDir, `${old}.meta`))).toBe(false);

    // A meta an older Walnut left behind after pruning the view itself.
    fs.mkdirSync(viewsDir, { recursive: true });
    fs.writeFileSync(path.join(viewsDir, 'rv-orphan.meta'), JSON.stringify({ savedAt: new Date().toISOString(), readyKey: 'k3' }));
    _resetHistoryViewsForTesting();
    expect(await readHistoryViewMeta('rv-orphan')).toBeNull();
    await pruneHistoryViews();
    expect(fs.existsSync(path.join(viewsDir, 'rv-orphan.meta'))).toBe(false);
  });

  it('a view an older Walnut wrote (no meta) reads as a view with no meta', async () => {
    fs.mkdirSync(viewsDir, { recursive: true });
    fs.writeFileSync(path.join(viewsDir, 'rv-legacy.json'), JSON.stringify({ schema: HISTORY_CACHE_SCHEMA, messages: [row(0)], total: 1, savedAt: new Date().toISOString() }));
    expect((await readHistoryView('rv-legacy'))?.messages).toHaveLength(1);
    _resetHistoryViewsForTesting();
    expect(await readHistoryViewMeta('rv-legacy')).toBeNull();
  });
});
