/**
 * A tail-bounded cold read of a transcript over the full read's byte ceiling grows by
 * the appended bytes, like a full entry does.
 *
 * 2026-11-16, measured on the Mac server: a transcript over DaemonFileReader's ceiling
 * (32 MB) can never be read whole, so the window it was served from had NO incremental
 * state, and every change of the file (each turn end, reconnect, refetch) pulled and
 * parsed a fresh 4 MB tail: 93, 133 and 110 such reads an hour, 50 to 94 s an hour,
 * 0.4 to 0.5 GB an hour (49 MB remote session: 1.5 to 8 s of link time each).
 *
 * Pinned here, through the real read pipeline over a temp CLAUDE_HOME, with the ceiling
 * lowered so a small fixture takes the production path:
 *   - an append is read as a range of the new bytes only, and the rows equal a fresh window's;
 *   - a message spanning the old end, and a trailing partial line, come out right;
 *   - a shrink and a rewrite drop back to a fresh window;
 *   - a full-read caller is never answered from the windowed state;
 *   - nothing windowed reaches the disk cache, appended rounds included;
 *   - a window with a frozen prefix: a result for a prefix tool bails, and a state that
 *     covers over two windows is dropped (its memory is bounded);
 *   - a file replaced by another (a new epoch) reads a fresh window;
 *   - a full parse that lands while a window grows is kept.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

const reads = vi.hoisted(() => ({ whole: [] as string[], ranges: [] as Array<{ start: number; bytes: number }>, onRange: null as null | (() => void) }));
/** Sessions with a recorded in-place rewind (the record's inPlaceRewinds), for the rewind case. */
const rewound = vi.hoisted(() => new Set<string>());
vi.mock('../../src/core/session-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSessionByClaudeId: async (sid: string) => (rewound.has(sid)
    ? { inPlaceRewinds: [{ uuid: 'u-gone', lastUuidAtCommit: 'u-gone', at: '2026-11-17T00:00:00Z' }] } : undefined),
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-history-win-inc', {
  HISTORY_CACHE_DIR: path.join(os.tmpdir(), `walnut-history-win-inc-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'cache', 'history'),
}));
vi.mock('../../src/core/daemon-file-reader.js', async () => {
  const { mockLocalDaemonReader } = await import('../helpers/mock-local-daemon-reader.js');
  const Base = mockLocalDaemonReader().DaemonFileReader;
  class Counting extends Base {
    async readFile(p: string) { reads.whole.push(p); return super.readFile(p); }
    // The range read rides on the bytes read in the mock, as in the real reader.
    async readFileRangeBuffer(p: string, start: number) {
      const res = await super.readFileRangeBuffer(p, start);
      if (res) reads.ranges.push({ start, bytes: res.buf.length });
      reads.onRange?.();
      return res;
    }
  }
  return { DaemonFileReader: Counting };
});

import { CLAUDE_HOME, HISTORY_CACHE_DIR } from '../../src/constants.js';
import {
  encodeProjectPath,
  readSessionHistory,
  isWindowedHistory,
  historyWindowStart,
  _resetHistoryCacheForTesting,
  _historyCacheGetForTesting,
  _historyCacheSetForTesting,
  type SessionHistoryMessage,
} from '../../src/core/session-history.js';
import { flushHistoryCacheWrites } from '../../src/core/history-disk-cache.js';

const CWD = '/tmp/windowed-inc-project';
const prevLimit = process.env.WALNUT_MAX_FILE_READ_BYTES;
/** Ceiling and window of the small fixtures: the file is over both. */
const CEILING = 16 * 1024;
const WINDOW = 8 * 1024;
const win = { skipSubagents: true, maxColdReadBytes: WINDOW };

beforeEach(async () => {
  await fsp.rm(CLAUDE_HOME, { recursive: true, force: true });
  await fsp.rm(HISTORY_CACHE_DIR, { recursive: true, force: true });
  await fsp.mkdir(CLAUDE_HOME, { recursive: true });
  // The cache module makes its dir once per process: keep it there for every test.
  await fsp.mkdir(HISTORY_CACHE_DIR, { recursive: true });
  _resetHistoryCacheForTesting();
  process.env.WALNUT_MAX_FILE_READ_BYTES = String(CEILING);
  reads.whole.length = 0;
  reads.ranges.length = 0;
  reads.onRange = null;
  rewound.clear();
});

afterEach(async () => {
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
}
/** Append raw text, then move the mtime on so no same-tick stamp can mask the growth. */
async function appendRaw(sid: string, text: string) {
  await fsp.appendFile(jsonl(sid), text);
  const t = new Date(Date.now() + 2_000 + Math.floor(Math.random() * 50_000));
  await fsp.utimes(jsonl(sid), t, t);
}
const append = (sid: string, lines: unknown[]) => appendRaw(sid, enc(lines));

let n = 0;
const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++n)).toISOString();
const user = (text: string) => ({ type: 'user', uuid: `u-${++n}`, timestamp: ts(), message: { role: 'user', content: text } });
const reply = (text: string, id = `msg_${++n}`) => ({ type: 'assistant', uuid: `a-${++n}`, timestamp: ts(), message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (toolId: string, id = `msg_${++n}`) => ({ type: 'assistant', uuid: `a-${++n}`, timestamp: ts(), message: { id, role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { cmd: 'x' } }] } });
const toolResult = (toolId: string, text: string) => ({ type: 'user', uuid: `u-${++n}`, timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }] }] } });

/** Turns of a few hundred bytes each: enough that the file is well over the window and the ceiling. */
function padding(count: number, tag = 'old'): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) out.push(user(`${tag} question ${i} ${'x'.repeat(150)}`), reply(`${tag} answer ${i} ${'y'.repeat(150)}`));
  return out;
}

/** What a row says, for comparing two parses. */
const view = (rows: SessionHistoryMessage[]) => rows.map((m) => [m.role, m.text, (m.tools ?? []).map((t) => [t.name, t.toolUseId, t.result])]);

/** A fresh window read of the file as it is now, leaving the warm entry (and its state) in place. */
async function freshWindow(sid: string): Promise<SessionHistoryMessage[]> {
  const warm = _historyCacheGetForTesting(sid)!;
  _resetHistoryCacheForTesting();
  const before = reads.ranges.length;
  const out = await readSessionHistory(sid, CWD, undefined, undefined, win);
  expect(reads.ranges.length).toBeGreaterThan(before);
  _resetHistoryCacheForTesting();
  _historyCacheSetForTesting(sid, warm);
  return out;
}

/** The rows a fresh window parse has are the newest of the grown entry's, row for row. */
function expectEndsWith(grown: SessionHistoryMessage[], fresh: SessionHistoryMessage[]) {
  expect(fresh.length).toBeGreaterThan(0);
  expect(grown.length).toBeGreaterThanOrEqual(fresh.length);
  expect(view(grown.slice(grown.length - fresh.length))).toEqual(view(fresh));
}

describe('a windowed cold read grows by the appended bytes', () => {
  it('reads only the new bytes on an append, and the rows equal a fresh window parse', async () => {
    const sid = 'win-inc-append';
    await write(sid, [...padding(60), user('before question'), reply('before answer')]);
    const first = await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(isWindowedHistory(first)).toBe(true);
    const start = historyWindowStart(first)!;
    expect(start.byte).toBeGreaterThan(0);
    const entry = _historyCacheGetForTesting(sid)!;
    expect(entry.windowed).toBe(true);
    expect(entry.inc?.window?.startByte).toBe(start.byte);
    // The cache-hit rule for a windowed entry keeps holding for the window it was asked for.
    expect(entry.approxChars).toBeGreaterThanOrEqual(WINDOW);
    expect(reads.ranges).toHaveLength(1);
    expect(reads.ranges[0]!.bytes).toBeGreaterThan(WINDOW - 400);

    await append(sid, [user('new question'), reply('new answer')]);
    reads.ranges.length = 0;
    const grown = await readSessionHistory(sid, CWD, undefined, undefined, win);

    // One range read, of the last line and what came after it: nowhere near the window.
    expect(reads.ranges).toHaveLength(1);
    expect(reads.ranges[0]!.bytes).toBeLessThan(1500);
    expect(reads.ranges[0]!.start).toBeGreaterThan(start.byte + WINDOW - 1000);
    expect(reads.whole).toEqual([]);
    // Still a window of the same start: it lacks the head and says so.
    expect(isWindowedHistory(grown)).toBe(true);
    expect(historyWindowStart(grown)).toEqual(start);
    expect(_historyCacheGetForTesting(sid)!.windowed).toBe(true);
    expect(_historyCacheGetForTesting(sid)!.approxChars).toBeGreaterThanOrEqual(WINDOW);
    expect(grown.map((m) => m.text)).toContain('new answer');
    expect(grown.length).toBeGreaterThan(first.length);
    expectEndsWith(grown, await freshWindow(sid));

    // And again: the state advanced, so the second append reads only its own bytes.
    await append(sid, [user('newer question'), reply('newer answer')]);
    reads.ranges.length = 0;
    const again = await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(reads.ranges).toHaveLength(1);
    expect(reads.ranges[0]!.bytes).toBeLessThan(1500);
    expectEndsWith(again, await freshWindow(sid));
  });

  it('a message whose lines span the old end, and a trailing partial line', async () => {
    const sid = 'win-inc-span';
    // The file ends inside an assistant message: its next line carries the same message id.
    await write(sid, [...padding(60), user('ask'), reply('part one of the message', 'msg_span')]);
    await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(_historyCacheGetForTesting(sid)!.inc?.window).toBeDefined();

    await append(sid, [toolUse('toolu_span_padpad', 'msg_span')]);
    reads.ranges.length = 0;
    const spanned = await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(reads.ranges).toHaveLength(1);
    expect(reads.ranges[0]!.bytes).toBeLessThan(1500);
    const last = spanned.at(-1)!;
    expect(last.text).toContain('part one of the message');
    expect(last.tools?.map((t) => t.toolUseId)).toEqual(['toolu_span_padpad']);
    expectEndsWith(spanned, await freshWindow(sid));

    // A line still being written: shown nowhere yet, and the state does not advance past it.
    const line = JSON.stringify(user('half written question'));
    await appendRaw(sid, line.slice(0, line.length - 12));
    reads.ranges.length = 0;
    const partial = await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(reads.ranges).toHaveLength(1);
    expect(partial.map((m) => m.text)).not.toContain('half written question');
    expectEndsWith(partial, await freshWindow(sid));

    // The line completes: read from the last COMPLETE line, so nothing is lost or doubled.
    await appendRaw(sid, line.slice(line.length - 12) + '\n');
    reads.ranges.length = 0;
    const done = await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(reads.ranges).toHaveLength(1);
    expect(reads.ranges[0]!.bytes).toBeLessThan(1500);
    expect(done.filter((m) => m.text === 'half written question')).toHaveLength(1);
    expectEndsWith(done, await freshWindow(sid));
  });

  it('a window cut inside a multi-byte character still reads only the new bytes', async () => {
    // The window's first byte is kept as a file offset: a decoded string would count a
    // cut character wrong, and every later read would then fail its last-line check.
    const sid = 'win-inc-multibyte';
    const cjk = Array.from({ length: 60 }, (_, i) => [user(`老问题${i} ${'汉'.repeat(90)}`), reply(`老答案${i} ${'字'.repeat(90)}`)]).flat();
    await write(sid, cjk);
    const size = (await fsp.stat(jsonl(sid))).size;
    // Slide the window one byte at a time until its first byte is a continuation byte.
    const bytes = await fsp.readFile(jsonl(sid));
    let windowBytes = WINDOW;
    while ((bytes[size - windowBytes]! & 0xc0) !== 0x80) windowBytes++;
    const opts = { skipSubagents: true, maxColdReadBytes: windowBytes };
    process.env.WALNUT_MAX_FILE_READ_BYTES = String(windowBytes + 4096);
    const first = await readSessionHistory(sid, CWD, undefined, undefined, opts);
    expect(_historyCacheGetForTesting(sid)!.inc?.window?.startByte).toBe(historyWindowStart(first)!.byte);
    await append(sid, [user('after the cut'), reply('answered')]);
    reads.ranges.length = 0;
    const grown = await readSessionHistory(sid, CWD, undefined, undefined, opts);
    expect(reads.ranges).toHaveLength(1);
    expect(reads.ranges[0]!.bytes).toBeLessThan(1500);
    expect(grown.map((m) => m.text)).toContain('answered');
  });

  it.each([
    ['a shrink (/compact)', async (sid: string) => write(sid, [...padding(20, 'compacted'), user('after compact'), reply('compact answer')])],
    ['a rewrite that grows', async (sid: string) => {
      await write(sid, [...padding(120, 'rewritten'), user('after rewrite'), reply('rewrite answer')]);
      const t = new Date(Date.now() + 90_000);
      await fsp.utimes(jsonl(sid), t, t);
    }],
    ['a rewrite of the same size', async (sid: string) => {
      const text = await fsp.readFile(jsonl(sid), 'utf-8');
      // Every old word says the same number of bytes in other letters, the last line's too.
      const swapped = text.replace(/\bold\b/g, 'new');
      expect(swapped.length).toBe(text.length);
      await fsp.writeFile(jsonl(sid), swapped);
      const t = new Date(Date.now() + 90_000);
      await fsp.utimes(jsonl(sid), t, t);
    }],
  ])('%s drops back to a fresh window read', async (_name, rewrite) => {
    const sid = `win-inc-rewrite-${_name.replace(/\W+/g, '-')}`;
    await write(sid, [...padding(60), user('old last question'), reply('end of the old run')]);
    await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(_historyCacheGetForTesting(sid)!.inc?.window).toBeDefined();

    await rewrite(sid);
    reads.ranges.length = 0;
    const after = await readSessionHistory(sid, CWD, undefined, undefined, win);
    const size = (await fsp.stat(jsonl(sid))).size;

    // A whole window was read again (a range from the file's new window start), nothing of the old rows survived.
    const whole = reads.ranges.find((r) => r.bytes > WINDOW - 400);
    expect(whole).toBeDefined();
    expect(whole!.start).toBe(Math.max(0, size - WINDOW));
    expect(isWindowedHistory(after)).toBe(true);
    const fresh = await freshWindow(sid);
    expect(view(after)).toEqual(view(fresh));
    expect(after.map((m) => m.text).join('\n')).not.toContain('old last question');
    // The state it was left with is the new file's.
    expect(_historyCacheGetForTesting(sid)!.inc?.window?.startByte).toBe(historyWindowStart(after)!.byte);
  });
});

describe('what a windowed entry may answer', () => {
  it('a full-read caller is never answered from the windowed state, appended or not', async () => {
    const sid = 'win-inc-full-caller';
    await write(sid, [...padding(60), user('window question'), reply('window answer')]);
    const windowed = await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(isWindowedHistory(windowed)).toBe(true);
    // The file now fits the full read (the ceiling is no longer in the way), and grew.
    process.env.WALNUT_MAX_FILE_READ_BYTES = String(1024 * 1024);
    await append(sid, [user('later question'), reply('later answer')]);
    reads.ranges.length = 0;
    reads.whole.length = 0;

    const full = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    // The whole file was read, none of it served from the window plus a range.
    expect(reads.whole.some((p) => p.endsWith(`${sid}.jsonl`))).toBe(true);
    expect(isWindowedHistory(full)).toBe(false);
    expect(full.length).toBe(60 * 2 + 4);
    expect(full[0]!.text).toContain('old question 0');
    expect(_historyCacheGetForTesting(sid)!.windowed).toBeFalsy();
  });

  it('a window caller wider than the held window reads its own window', async () => {
    const sid = 'win-inc-wider';
    await write(sid, [...padding(60), user('q'), reply('a')]);
    const narrow = await readSessionHistory(sid, CWD, undefined, undefined, win);
    await append(sid, [user('q2'), reply('a2')]);
    reads.ranges.length = 0;
    const wider = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true, maxColdReadBytes: CEILING });
    expect(wider.length).toBeGreaterThan(narrow.length);
    expect(reads.ranges.some((r) => r.bytes > WINDOW + 1000)).toBe(true);
  });

  it('nothing windowed reaches the disk cache, appended rounds included', async () => {
    const sid = 'win-inc-no-disk';
    await write(sid, [...padding(60), user('q'), reply('a')]);
    await readSessionHistory(sid, CWD, undefined, undefined, win);
    for (let i = 0; i < 3; i++) {
      await append(sid, [user(`round ${i}`), reply(`round ${i} answer`)]);
      const out = await readSessionHistory(sid, CWD, undefined, undefined, win);
      expect(out.map((m) => m.text)).toContain(`round ${i} answer`);
    }
    // A write is queued a tick after its read returns: let it land before looking.
    flushHistoryCacheWrites();
    await new Promise((r) => setTimeout(r, 50));
    const files = await fsp.readdir(HISTORY_CACHE_DIR);
    expect(files.filter((f) => f.startsWith(sid))).toEqual([]);
  });
});

describe('a window with a frozen prefix', () => {
  const BIG_CEILING = 5 * 1024 * 1024;
  const BIG_WINDOW = 3 * 1024 * 1024;
  const big = { skipSubagents: true, maxColdReadBytes: BIG_WINDOW };
  /** Paired tool turns of ~250 KB each. */
  const bulk = (tag: string, count: number): unknown[] => {
    const out: unknown[] = [];
    for (let i = 0; i < count; i++) out.push(toolUse(`toolu_${tag}_${i}_padpad`), toolResult(`toolu_${tag}_${i}_padpad`, 'X'.repeat(250_000)));
    return out;
  };

  it('a result for a prefix tool reads a fresh window, and a state past two windows is dropped', async () => {
    process.env.WALNUT_MAX_FILE_READ_BYTES = String(BIG_CEILING);
    const sid = 'win-inc-big';
    // The unanswered tool sits ~1.5 MB from the end: inside the 3 MB window, before its last 1 MB.
    await write(sid, [user('start'), ...bulk('a', 20), toolUse('toolu_pending_padpad'), ...bulk('b', 6), reply('big tail')]);
    await readSessionHistory(sid, CWD, undefined, undefined, big);
    const seeded = _historyCacheGetForTesting(sid)!.inc!;
    expect(seeded.window).toBeDefined();
    expect(seeded.prefixMessages.length).toBeGreaterThan(0);
    expect(seeded.pendingToolIds).toContain('toolu_pending_padpad');
    const startAt = seeded.window!.startByte;

    // An ordinary append: only the new bytes.
    await append(sid, [user('big question'), reply('big answer')]);
    reads.ranges.length = 0;
    const plain = await readSessionHistory(sid, CWD, undefined, undefined, big);
    expect(reads.ranges).toHaveLength(1);
    expect(reads.ranges[0]!.bytes).toBeLessThan(10_000);
    expect(plain.map((m) => m.text)).toContain('big answer');
    expect(_historyCacheGetForTesting(sid)!.inc!.window!.startByte).toBe(startAt);

    // The pending tool's result lands: the frozen prefix cannot take it, so a fresh window is read
    // (a local transcript keeps no tail window: session-history-window-reuse.test.ts has a host's).
    await append(sid, [toolResult('toolu_pending_padpad', 'finally done')]);
    reads.ranges.length = 0;
    const settled = await readSessionHistory(sid, CWD, undefined, undefined, big);
    expect(reads.ranges.some((r) => r.bytes > BIG_WINDOW - 400_000)).toBe(true);
    const pending = settled.flatMap((m) => m.tools ?? []).find((t) => t.toolUseId === 'toolu_pending_padpad');
    expect(pending?.result).toContain('finally done');
    const reseeded = _historyCacheGetForTesting(sid)!.inc!;
    // A new state (its start may stay on the same 250 KB line: the file grew by a few bytes).
    expect(reseeded).not.toBe(seeded);
    expect(reseeded.window!.startByte).toBeGreaterThanOrEqual(startAt);

    // After ~3.5 MB more the state covers over two windows (its memory bound), so it is
    // dropped for a fresh window.
    await append(sid, bulk('c', 14));
    reads.ranges.length = 0;
    const grown = await readSessionHistory(sid, CWD, undefined, undefined, big);
    expect(reads.ranges.some((r) => r.bytes > BIG_WINDOW - 400_000)).toBe(true);
    const after = _historyCacheGetForTesting(sid)!.inc!;
    expect(after.window!.startByte).toBeGreaterThan(reseeded.window!.startByte);
    expect(after.parsedBytes - after.window!.startByte).toBeLessThanOrEqual(2 * BIG_WINDOW);
    expect(isWindowedHistory(grown)).toBe(true);
  }, 60_000);
});

describe('what a windowed state must not outlive', () => {
  it('a file replaced by another (a new epoch) reads a fresh window, even when it only grew', async () => {
    const sid = 'win-inc-epoch';
    const lines = [...padding(60), user('before question'), reply('before answer')];
    await write(sid, lines);
    await readSessionHistory(sid, CWD, undefined, undefined, win);
    const epoch = _historyCacheGetForTesting(sid)!.inc!.window!.epoch;
    expect(epoch).toBeDefined();
    // The same bytes and more, as a NEW file renamed over the old one (another inode).
    const tmp = `${jsonl(sid)}.next`;
    await fsp.writeFile(tmp, enc([...lines, user('after question'), reply('after answer')]));
    const t = new Date(Date.now() + 5_000);
    await fsp.utimes(tmp, t, t);
    await fsp.rename(tmp, jsonl(sid));
    reads.ranges.length = 0;
    const out = await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(reads.ranges.some((r) => r.bytes > WINDOW - 400)).toBe(true);
    expect(out.map((m) => m.text)).toContain('after answer');
    expect(_historyCacheGetForTesting(sid)!.inc!.window!.epoch).not.toBe(epoch);
  });

  it('a full parse that lands while the window grows is kept (the session warms up for good)', async () => {
    const sid = 'win-inc-warm';
    await write(sid, [...padding(60), user('before question'), reply('before answer')]);
    await readSessionHistory(sid, CWD, undefined, undefined, win);
    const windowed = _historyCacheGetForTesting(sid)!;
    expect(windowed.windowed).toBe(true);
    await append(sid, [user('new question'), reply('new answer')]);
    // The warm-up's full parse lands while the window's growth is being read.
    const full = { mtimeMs: 1, size: 1, messages: [] as SessionHistoryMessage[], approxChars: 1 };
    reads.onRange = () => { reads.onRange = null; _historyCacheSetForTesting(sid, full); };
    const grown = await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(grown.map((m) => m.text)).toContain('new answer');
    expect(_historyCacheGetForTesting(sid)).toBe(full);
  });

  it('a rewind recorded while the window is read leaves it no state to grow (the growth path reads no cuts)', async () => {
    const sid = 'win-inc-rewound';
    await write(sid, [...padding(60), user('before question'), reply('before answer')]);
    reads.onRange = () => { reads.onRange = null; rewound.add(sid); };
    await readSessionHistory(sid, CWD, undefined, undefined, win);
    expect(rewound.has(sid)).toBe(true);
    expect(_historyCacheGetForTesting(sid)?.inc).toBeUndefined();
  });
});
