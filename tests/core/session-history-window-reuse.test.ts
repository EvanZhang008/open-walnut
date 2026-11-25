/**
 * A tail-bounded history read whose parse-cache entry is gone reads through the window kept
 * for the session (history-tail-window.ts) instead of moving the whole window again.
 *
 * 2026-11-25, the Mac's logs: GET /api/sessions/:id/history p95 2.9 s, max 16 s. The slow
 * reads were big transcripts of a remote host (54 to 285 MB), each a bounded cold read of
 * the last 4 MB, and 80 of 80 logged `prior: none`: the parse cache (64 Mi chars, a 4 MB
 * window charged 4 Mi) held about ten such windows while the background readers walked more
 * sessions than that, so every read found its entry pushed out and pulled 4 MB over the link
 * again (5 to 14 s each on a busy link). The window the transcript sweep keeps for the same
 * session was never asked.
 *
 * Pinned here, through the real read pipeline over a temp CLAUDE_HOME (the reader double
 * serves the host's files from it), with the ceiling lowered so a small fixture takes the
 * production path:
 *   - a pushed-out entry, file unchanged: the next read moves no bytes, same rows;
 *   - a pushed-out entry, file grown: the next read moves the appended bytes, not the window;
 *   - a window the sweep keeps answers the route's first cold read;
 *   - a one-off tail read keeps no new window, and a rewritten file still reads fresh;
 *   - a read with a filter of its own neither uses nor keeps a window;
 *   - local and preview reads keep none, so they never push a host's windows out;
 *   - a failed sweep read falls back to the full read, never answers an empty history.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

const reads = vi.hoisted(() => ({ ranges: [] as Array<{ start: number; bytes: number }>, failNext: 0 }));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-history-win-reuse', {
  HISTORY_CACHE_DIR: path.join(os.tmpdir(), `walnut-history-win-reuse-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'cache', 'history'),
}));
vi.mock('../../src/core/daemon-file-reader.js', async () => {
  const { mockLocalDaemonReader } = await import('../helpers/mock-local-daemon-reader.js');
  const Base = mockLocalDaemonReader().DaemonFileReader;
  // A host's reader, served from the same temp CLAUDE_HOME (the double serves only __local__).
  class Counting extends Base {
    constructor(_host: string) { super('__local__'); }
    async readFileRangeBuffer(p: string, start: number) {
      if (reads.failNext > 0) { reads.failNext--; throw new Error('fs.readRange transport failure: test'); }
      const res = await super.readFileRangeBuffer(p, start);
      if (res) reads.ranges.push({ start, bytes: res.buf.length });
      return res;
    }
  }
  return { DaemonFileReader: Counting };
});

import { CLAUDE_HOME, HISTORY_CACHE_DIR } from '../../src/constants.js';
import {
  encodeProjectPath,
  readSessionHistory,
  readSessionHistoryTail,
  readSessionHistoryTailWindow,
  isWindowedHistory,
  _settleHistoryWarmupsForTesting,
  _resetHistoryCacheForTesting,
  _historyCacheGetForTesting,
  _historyCacheSetForTesting,
  type SessionHistoryMessage,
} from '../../src/core/session-history.js';
import { flushHistoryCacheWrites } from '../../src/core/history-disk-cache.js';
import { HISTORY_OPEN_PREVIEW_BYTES } from '../../src/core/history-open-preview.js';
import { MAX_TAIL_WINDOWS } from '../../src/core/history-tail-window.js';

const CWD = '/tmp/window-reuse-project';
const prevLimit = process.env.WALNUT_MAX_FILE_READ_BYTES;
/** The host the sessions run on: only a host's windows are kept (a local read is cheap). */
const HOST = 'devbox';
/** Wider than a first-paint preview (those are never kept), under the lowered ceiling. */
const WINDOW = HISTORY_OPEN_PREVIEW_BYTES + 64 * 1024;
const CEILING = 2 * WINDOW;
const win = { skipSubagents: true, maxColdReadBytes: WINDOW };
/** A transcript well over the ceiling, and one only over the window (a local one, a preview's). */
const BIG = 1_000;
const SMALL = 450;

beforeEach(async () => {
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true });
  await fsp.mkdir(CLAUDE_HOME, { recursive: true });
  await fsp.mkdir(HISTORY_CACHE_DIR, { recursive: true });
  _resetHistoryCacheForTesting();
  process.env.WALNUT_MAX_FILE_READ_BYTES = String(CEILING);
  reads.ranges.length = 0;
  reads.failNext = 0;
});
afterEach(async () => {
  await _settleHistoryWarmupsForTesting();
  flushHistoryCacheWrites();
  await new Promise((r) => setTimeout(r, 20));
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
  if (prevLimit === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES;
  else process.env.WALNUT_MAX_FILE_READ_BYTES = prevLimit;
});
afterAll(async () => {
  await fsp.rm(path.dirname(path.dirname(HISTORY_CACHE_DIR)), { recursive: true, force: true }).catch(() => {});
});

const jsonl = (sid: string) => path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${sid}.jsonl`);
const enc = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
async function write(sid: string, lines: unknown[]) {
  await fsp.mkdir(path.dirname(jsonl(sid)), { recursive: true });
  await fsp.writeFile(jsonl(sid), enc(lines));
  await touch(sid);
}
/** Move the mtime on so no same-tick stamp can mask a change. */
async function touch(sid: string) {
  const t = new Date(Date.now() + 2_000 + Math.floor(Math.random() * 50_000));
  await fsp.utimes(jsonl(sid), t, t);
}
async function append(sid: string, lines: unknown[]) {
  await fsp.appendFile(jsonl(sid), enc(lines));
  await touch(sid);
}

let n = 0;
const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++n)).toISOString();
const user = (text: string) => ({ type: 'user', uuid: `u-${++n}`, timestamp: ts(), message: { role: 'user', content: text } });
const reply = (text: string) => ({ type: 'assistant', uuid: `a-${++n}`, timestamp: ts(), message: { id: `msg_${++n}`, role: 'assistant', content: [{ type: 'text', text }] } });
function padding(count: number, tag = 'old'): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) out.push(user(`${tag} question ${i} ${'x'.repeat(150)}`), reply(`${tag} answer ${i} ${'y'.repeat(150)}`));
  return out;
}
const view = (rows: SessionHistoryMessage[]) => rows.map((m) => [m.role, m.text]);
const moved = () => reads.ranges.reduce((sum, r) => sum + r.bytes, 0);

/** What the background readers did to the parse cache: one big entry read later pushes this session's out. */
function pushOut(sid: string) {
  _historyCacheSetForTesting('another-session', { mtimeMs: 1, size: 1, messages: [], approxChars: 64 * 1024 * 1024 + 1 }, HOST);
  expect(_historyCacheGetForTesting(sid, HOST)).toBeUndefined();
}

/** A fresh window read of the file as it is now, with nothing kept. */
async function freshRows(sid: string): Promise<SessionHistoryMessage[]> {
  _resetHistoryCacheForTesting();
  return readSessionHistory(sid, CWD, HOST, undefined, win);
}
/** null: a session of this machine. */
const read = (sid: string, host: string | null = HOST, opts = win) => readSessionHistory(sid, CWD, host ?? undefined, undefined, opts);

describe('a bounded cold read reads through the kept tail window', () => {
  it('an unchanged transcript whose entry was pushed out moves no bytes, and gives the same rows', async () => {
    const sid = 'reuse-unchanged';
    await write(sid, [...padding(BIG), user('last question'), reply('last answer')]);
    const first = await read(sid);
    expect(isWindowedHistory(first)).toBe(true);
    expect(moved()).toBeGreaterThan(WINDOW - 400);

    for (let round = 0; round < 3; round++) {
      pushOut(sid);
      reads.ranges.length = 0;
      const again = await read(sid);
      // Old code: a fresh window each round (about WINDOW bytes moved every time).
      expect(reads.ranges).toEqual([]);
      expect(isWindowedHistory(again)).toBe(true);
      expect(view(again)).toEqual(view(first));
      // The parse cache holds it again, so the next read is a plain hit.
      expect(_historyCacheGetForTesting(sid, HOST)?.windowed).toBe(true);
    }
  });

  it('a grown transcript whose entry was pushed out moves the appended bytes, not the window', async () => {
    const sid = 'reuse-grown';
    await write(sid, [...padding(BIG), user('q0'), reply('a0')]);
    await read(sid);

    for (let round = 1; round <= 4; round++) {
      await append(sid, [user(`new question ${round}`), reply(`new answer ${round}`)]);
      pushOut(sid);
      reads.ranges.length = 0;
      const grown = await read(sid);
      expect(moved()).toBeGreaterThan(0);
      expect(moved()).toBeLessThan(1_500);
      expect(grown.map((m) => m.text)).toContain(`new answer ${round}`);
      // The same rows a fresh window read of the grown file parses.
      const fresh = await freshRows(sid);
      expect(view(grown)).toEqual(view(fresh));
    }
  });

  it('the window the transcript sweep keeps answers the first cold read of the route', async () => {
    const sid = 'reuse-sweep';
    await write(sid, [...padding(BIG), user('swept question'), reply('swept answer')]);
    const swept = await readSessionHistoryTail(sid, CWD, HOST, undefined, WINDOW, { poll: true });
    expect(swept).not.toBeNull();
    expect(_historyCacheGetForTesting(sid, HOST)).toBeUndefined();
    reads.ranges.length = 0;

    const routeRead = await read(sid);
    expect(reads.ranges).toEqual([]);
    expect(view(routeRead)).toEqual(view(swept!));
    expect(isWindowedHistory(routeRead)).toBe(true);
  });

  it('a one-off tail read keeps no new window, and a rewritten file reads a fresh one', async () => {
    const sid = 'reuse-one-off';
    await write(sid, [...padding(BIG), user('q'), reply('a')]);
    await readSessionHistoryTail(sid, CWD, HOST, undefined, WINDOW);
    reads.ranges.length = 0;
    await read(sid);
    // Nothing was kept by the one-off read: the route read its own window.
    expect(moved()).toBeGreaterThan(WINDOW - 400);

    // Same size, other bytes (an in-place rewrite): the kept window must not answer.
    const text = await fsp.readFile(jsonl(sid), 'utf-8');
    await fsp.writeFile(jsonl(sid), text.replace(/"a"\}\]/, '"b"}]'));
    await touch(sid);
    pushOut(sid);
    reads.ranges.length = 0;
    const rewritten = await read(sid);
    expect(moved()).toBeGreaterThan(WINDOW - 400);
    expect(rewritten.at(-1)?.text).toBe('b');
  });

  it('a read with a filter of its own neither answers from a kept window nor keeps one', async () => {
    const sid = 'reuse-filtered';
    await write(sid, [...padding(BIG), user('q'), reply('a')]);
    await read(sid);
    pushOut(sid);
    const filter = { toolResultMax: { toolUseId: 'toolu_none', max: 10 } };
    for (let i = 0; i < 2; i++) {
      reads.ranges.length = 0;
      const rows = await readSessionHistoryTailWindow(sid, CWD, HOST, WINDOW, filter);
      expect(rows?.at(-1)?.text).toBe('a');
      expect(moved()).toBeGreaterThan(WINDOW - 2_000);
    }
    // The window kept before is still the one the route reads from.
    reads.ranges.length = 0;
    await read(sid);
    expect(reads.ranges).toEqual([]);
  });

  it('local reads and first-paint previews keep no window, so a host session keeps its own', async () => {
    const sid = 'reuse-pressed';
    await write(sid, [...padding(BIG), user('host question'), reply('host answer')]);
    await read(sid);
    // More local sessions and previews than the windows kept: none of them may take a place.
    for (let i = 0; i < MAX_TAIL_WINDOWS + 4; i++) {
      await write(`local-${i}`, [...padding(SMALL, `l${i}`), user('lq'), reply('la')]);
      expect((await read(`local-${i}`, null)).at(-1)?.text).toBe('la');
      await write(`preview-${i}`, [...padding(SMALL, `p${i}`), user('pq'), reply('pa')]);
      const preview = await read(`preview-${i}`, HOST, { skipSubagents: true, maxColdReadBytes: HISTORY_OPEN_PREVIEW_BYTES });
      expect(preview.at(-1)?.text).toBe('pa');
    }
    pushOut(sid);
    reads.ranges.length = 0;
    const again = await read(sid);
    expect(reads.ranges).toEqual([]);
    expect(again.at(-1)?.text).toBe('host answer');
  }, 60_000);

  it('a sweep read whose transfer fails falls back to the full read, never an empty history', async () => {
    const sid = 'reuse-failed';
    await write(sid, [...padding(BIG), user('q'), reply('the answer')]);
    reads.failNext = 1;
    const rows = await readSessionHistoryTail(sid, CWD, HOST, undefined, WINDOW, { poll: true });
    expect(rows).not.toBeNull();
    expect(rows!.at(-1)?.text).toBe('the answer');
  });
});
