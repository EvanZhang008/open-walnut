/**
 * The whale-session bounded-tail path, through the REAL read pipeline.
 *
 * inc-1785993576822 — a 55.8 MB transcript exceeds DaemonFileReader's byte ceiling, so
 * every single read (1252 of them for that one session) degraded to
 * readSessionHistoryTailWindow: a 4 MiB SLIDING tail. Two consequences, both proven
 * live and both fixed here:
 *
 *  1. The window's LENGTH is not a cursor space — it moves DOWN as the head is
 *     evicted while the turn appends at the tail. The ?since= delta sliced it by
 *     count anyway, silently omitting the newest messages (the user's own echo among
 *     them), so their optimistic bubble had no absorption evidence and stayed pinned
 *     at the bottom of the timeline forever. Fix = mark the parse `windowed` so the
 *     route refuses an anchorless delta.
 *  2. The window path never called bindEchoClaims, so `walnutMessageId` was null on
 *     every message of every whale session (verified: 0 of 1752) — the frontend's
 *     STRONGEST dedup pass was dead code exactly where it was needed most.
 *
 * These tests drive readSessionHistory itself (not a helper), with the ceiling lowered
 * so a small fixture takes the same degradation path production takes.
 */
import fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
const delayedRanges = vi.hoisted(() => ({ small: false, entered: undefined as (() => void) | undefined, release: undefined as Promise<void> | undefined }));
const wholeReads = vi.hoisted(() => [] as string[]);
const failRanges = vi.hoisted(() => ({ on: false }));
const rangeReads = vi.hoisted(() => [] as Array<{ path: string; start: number }>);
vi.mock('../../src/core/daemon-file-reader.js', () => {
  const actual = mockLocalDaemonReader();
  class Reader extends actual.DaemonFileReader {
    async readFile(remotePath: string) {
      wholeReads.push(remotePath);
      return super.readFile(remotePath);
    }
    // The window read takes bytes (its start is kept as a file offset), and readFileRange rides on it.
    async readFileRangeBuffer(remotePath: string, start: number) {
      rangeReads.push({ path: remotePath, start });
      if (failRanges.on) return null;
      const result = await super.readFileRangeBuffer(remotePath, start);
      if (delayedRanges.small && result && result.fileSize - start <= 2048) {
        delayedRanges.entered?.();
        await delayedRanges.release;
      }
      return result;
    }
  }
  return { ...actual, DaemonFileReader: Reader };
});

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  readSessionHistory,
  readSessionHistoryTail,
  isWindowedHistory,
  historyWindowStart,
  _resetHistoryCacheForTesting,
} from '../../src/core/session-history.js';
import { readSessionHistoryBefore, _resetHistoryPagesForTests } from '../../src/core/session-history-pages.js';
import { registerEchoClaims, _resetEchoClaimsForTest } from '../../src/core/echo-claims.js';
import { log } from '../../src/logging/index.js';

const tmpBase = CLAUDE_HOME as string;
const CWD = '/tmp/windowed-test-project';
const prevLimit = process.env.WALNUT_MAX_FILE_READ_BYTES;

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  _resetHistoryCacheForTesting();
  _resetEchoClaimsForTest();
  delayedRanges.small = false;
  delayedRanges.entered = undefined;
  delayedRanges.release = undefined;
  wholeReads.length = 0;
  rangeReads.length = 0;
  failRanges.on = false;
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  if (prevLimit === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES;
  else process.env.WALNUT_MAX_FILE_READ_BYTES = prevLimit;
  vi.restoreAllMocks();
});

function jsonlPath(sessionId: string): string {
  return path.join(tmpBase, 'projects', encodeProjectPath(CWD), `${sessionId}.jsonl`);
}

async function writeLines(sessionId: string, lines: unknown[]): Promise<void> {
  const p = jsonlPath(sessionId);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

let uuidSeq = 0;
const userLine = (text: string, ts: string) => ({
  type: 'user', uuid: `u-${++uuidSeq}`, timestamp: ts,
  message: { role: 'user', content: text },
});
const asstLine = (text: string, ts: string) => ({
  type: 'assistant', uuid: `a-${++uuidSeq}`, timestamp: ts,
  message: { role: 'assistant', id: `msg_${uuidSeq}`, content: [{ type: 'text', text }] },
});

/** Enough padding turns that the file blows past a deliberately tiny ceiling. */
function padding(count: number): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) {
    out.push(userLine(`old question ${i} ${'x'.repeat(200)}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
    out.push(asstLine(`old answer ${i} ${'y'.repeat(200)}`, new Date(Date.UTC(2026, 0, 1, 0, i, 30)).toISOString()));
  }
  return out;
}

describe('whale-session bounded tail', () => {
  it('marks the parse as windowed so the delta path cannot slice it by count', async () => {
    const sid = 'whale-1';
    await writeLines(sid, padding(60));
    // Ceiling below the file size, tail window above it → the exact production shape.
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';

    const messages = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    expect(messages.length).toBeGreaterThan(0);
    // The window necessarily holds FEWER messages than the file — that gap is exactly
    // what made the count-based cursor lossy.
    expect(messages.length).toBeLessThan(120);
    expect(isWindowedHistory(messages)).toBe(true);
  });

  it('a stat over the ceiling goes straight to the tail: no whole-file read, no warn', async () => {
    // 2026-11-13: every open of a long session first asked for the whole file,
    // was refused on its size, and only then read the tail: three warn lines per
    // read, about 2,000 a day, which raised a chronic log alarm. The stat already
    // knows the size, so the doomed read must never be attempted.
    const sid = 'whale-precheck';
    await writeLines(sid, [...padding(60), userLine('latest question', '2026-01-02T00:00:00.000Z')]);
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';
    const warn = vi.spyOn(log.session, 'warn');

    const messages = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    expect(isWindowedHistory(messages)).toBe(true);
    expect(messages.map(m => m.text)).toContain('latest question');
    expect(wholeReads.filter(p => p.endsWith(`${sid}.jsonl`))).toEqual([]);
    expect(warn.mock.calls.map(c => c[0])).toEqual([]);
  });

  // The class: a read that did not happen must never answer as an existing, empty
  // conversation (the client replaces what it shows with "No conversation history
  // found"). 2026-11-16: an 811 MB transcript's tail read failed during a deploy.
  it('an over-ceiling tail that cannot be read fails the read instead of answering empty', async () => {
    const { HistoryReadFailedError } = await import('../../src/core/session-history.js');
    const sid = 'whale-tail-fails';
    await writeLines(sid, [...padding(60), userLine('latest question', '2026-01-02T00:00:00.000Z')]);
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';
    failRanges.on = true;
    await expect(readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true }))
      .rejects.toBeInstanceOf(HistoryReadFailedError);
  });

  it('an over-ceiling tail that cannot be read serves the previous parse when there is one', async () => {
    const sid = 'whale-tail-fails-cached';
    await writeLines(sid, [...padding(60), userLine('latest question', '2026-01-02T00:00:00.000Z')]);
    // A cold tail-bounded read caches its window.
    const first = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true, maxColdReadBytes: 4096 });
    expect(first.map(m => m.text)).toContain('latest question');
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';
    // The file changes (so the cache is not fresh) and the next tail read fails.
    await fsp.appendFile(jsonlPath(sid), JSON.stringify(asstLine('later answer', '2026-01-02T00:00:09.000Z')) + '\n');
    failRanges.on = true;
    const again = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(again.map(m => m.text)).toContain('latest question');
  });

  // 2026-11-21 prod heap snapshot: re-reading and re-parsing the 4 MB tail of an
  // over-ceiling transcript on every request (up to 100 an hour on a 940 MB session)
  // left about 8 MB of strings per read for the collector.
  it('an over-ceiling tail is read once per stat: the next caller is answered from the cache', async () => {
    const sid = 'whale-cached-tail';
    await writeLines(sid, [...padding(60), userLine('latest question', '2026-01-02T00:00:00.000Z')]);
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';
    const first = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    const readsAfterFirst = rangeReads.filter(r => r.path.endsWith(`${sid}.jsonl`)).length;
    expect(readsAfterFirst).toBeGreaterThan(0);

    const second = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(rangeReads.filter(r => r.path.endsWith(`${sid}.jsonl`)).length).toBe(readsAfterFirst);
    expect(second.map(m => m.text)).toEqual(first.map(m => m.text));
    expect(isWindowedHistory(second)).toBe(true);
  });

  it('an append to a cached over-ceiling tail reads only the new bytes and shows the new message', async () => {
    const sid = 'whale-cached-grow';
    await writeLines(sid, [...padding(60), userLine('latest question', '2026-01-02T00:00:00.000Z')]);
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    const sizeBefore = (await fsp.stat(jsonlPath(sid))).size;
    rangeReads.length = 0;

    await fsp.appendFile(jsonlPath(sid), JSON.stringify(asstLine('fresh answer', '2026-01-02T00:00:05.000Z')) + '\n');
    const grown = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    expect(grown.map(m => m.text)).toContain('fresh answer');
    expect(grown.map(m => m.text)).toContain('latest question');
    const reads = rangeReads.filter(r => r.path.endsWith(`${sid}.jsonl`));
    expect(reads.length).toBeGreaterThan(0);
    // The incremental read starts at the last line it already parsed (it re-checks that
    // line), never at a new 4 KB window: far past where a fresh window would begin.
    expect(reads.length).toBe(1);
    expect(reads[0]!.start).toBeGreaterThan(sizeBefore - 400);
  });

  it('after an append, the next caller at the same stat is answered from the cache', async () => {
    const sid = 'whale-cached-grow-twice';
    await writeLines(sid, [...padding(60), userLine('latest question', '2026-01-02T00:00:00.000Z')]);
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    await fsp.appendFile(jsonlPath(sid), JSON.stringify(asstLine('fresh answer', '2026-01-02T00:00:05.000Z')) + '\n');
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    rangeReads.length = 0;
    const again = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(again.map(m => m.text)).toContain('fresh answer');
    expect(rangeReads.filter(r => r.path.endsWith(`${sid}.jsonl`))).toEqual([]);
  });

  it('a full-width tail kept by a tail-bounded caller answers an unbounded caller too', async () => {
    // The production shape at small scale: a 5 MB file past a 4.5 MB ceiling, opened by
    // the UI's ?tail= read (a 4 MB cold window) before any unbounded caller.
    const sid = 'whale-cold-then-full';
    await writeLines(sid, [...padding(11_000), userLine('latest question', '2026-01-02T00:00:00.000Z')]);
    process.env.WALNUT_MAX_FILE_READ_BYTES = String(Math.round(4.5 * 1024 * 1024));
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true, maxColdReadBytes: 4 * 1024 * 1024 });
    rangeReads.length = 0;
    const unbounded = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(unbounded.map(m => m.text)).toContain('latest question');
    expect(rangeReads.filter(r => r.path.endsWith(`${sid}.jsonl`))).toEqual([]);
  });

  it('the only empty answer is a missing source: every [] return in the reader is that one', () => {
    // Enumerated from the source: a new empty return in readSessionHistoryInner fails here
    // until it is shown to be a missing file, not a failed read.
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/session-history.ts'), 'utf8');
    const inner = src.slice(src.indexOf('async function readSessionHistoryInner('));
    const body = inner.slice(0, inner.indexOf('\n}\n'));
    const empties = [...body.matchAll(/handOff\(\[\]\)|handOff\([^)]*(?:\?\?|\|\|) \[\]\)|return \[\];/g)].map(m => m[0]);
    expect(empties).toEqual(['handOff([])']);
    expect(body).toMatch(/if \(!messages && result\) throw new HistoryReadFailedError[^\n]*\n\s*if \(!messages\) return handOff\(\[\]\);/);
  });

  it('a full read is NOT marked windowed (the flag is not sticky per session)', async () => {
    const sid = 'small-1';
    await writeLines(sid, [userLine('hi', '2026-01-01T00:00:00.000Z'), asstLine('hello', '2026-01-01T00:00:01.000Z')]);
    const messages = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(isWindowedHistory(messages)).toBe(false);
  });

  it('binds echo claims on the window path — pass 1 is no longer dead code', async () => {
    const sid = 'whale-2';
    // bindEchoClaims refuses an echo that PREDATES the claim (identical short texts
    // recur across old turns), so the echo line must be stamped at/after delivery —
    // i.e. around now, not at a fixture date in the past.
    registerEchoClaims(sid, ['qm-777'], 'the newest question');
    const ts = new Date(Date.now() + 1_000).toISOString();
    await writeLines(sid, [
      ...padding(60),
      userLine('the newest question', ts),
      asstLine('the newest answer', new Date(Date.now() + 2_000).toISOString()),
    ]);
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';

    const messages = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    expect(isWindowedHistory(messages)).toBe(true);
    const bound = messages.find(m => m.walnutMessageId === 'qm-777');
    // Before the fix this was undefined for EVERY message of EVERY whale session.
    expect(bound).toBeDefined();
    expect(bound?.text).toBe('the newest question');
  });

  it('serves the tail for a hashed-cwd whale (encoded cwd >200 chars, no cached path)', async () => {
    // inc-1786390337224: Claude Code hashes cwds whose encoded form exceeds 200
    // chars, so we can't compute the exact JSONL path — and the resolved-path
    // cache is only seeded by a successful FULL read, which a whale can never
    // complete. The tail-window fallback then had no stat path and returned
    // null → the UI showed "No conversation" for a healthy 70 MB live session.
    const sid = 'whale-hashed-1';
    const longCwd = '/tmp/' + 'deeply-nested-project-dir/'.repeat(10); // encodes to >200 chars
    expect(encodeProjectPath(longCwd).length).toBeGreaterThan(200);
    // On disk the dir name is Claude Code's hashed form — anything ≠ our encoding.
    const hashedDir = path.join(tmpBase, 'projects', '-tmp-deeply-nested-pro-abc123');
    await fsp.mkdir(hashedDir, { recursive: true });
    await fsp.writeFile(
      path.join(hashedDir, `${sid}.jsonl`),
      [...padding(60), userLine('hashed final question', '2026-01-02T00:00:00.000Z')]
        .map(l => JSON.stringify(l)).join('\n') + '\n',
    );
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';

    const messages = await readSessionHistory(sid, longCwd, undefined, undefined, { skipSubagents: true });

    expect(messages.length).toBeGreaterThan(0);
    expect(isWindowedHistory(messages)).toBe(true);
    expect(messages.map(m => m.text)).toContain('hashed final question');
  });

  it('the window keeps the NEWEST messages (what the UI actually shows)', async () => {
    const sid = 'whale-3';
    await writeLines(sid, [
      ...padding(60),
      userLine('final question', '2026-01-02T00:00:00.000Z'),
      asstLine('final answer', '2026-01-02T00:00:05.000Z'),
    ]);
    process.env.WALNUT_MAX_FILE_READ_BYTES = '4096';

    const messages = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    const texts = messages.map(m => m.text);
    expect(texts).toContain('final question');
    expect(texts).toContain('final answer');
  });
});

/**
 * inc-1786572252481 — ?tail=400 bounded the RESPONSE but not the READ: a cold
 * cache still transferred + parsed the whole 9.5 MB remote JSONL (10-16 s per
 * panel open) because the file sat UNDER the 32 MB ceiling, so the degradation
 * path above never engaged. Tail-bounded callers now pass maxColdReadBytes and
 * a cold read bigger than it reads only the last window.
 */
describe('cold tail-bounded read (maxColdReadBytes)', () => {
  // Both seams: `start` inside a line, and `start` exactly on a line's first byte (the
  // tail drops that whole line, so the page must own it: review of 2026-11-16).
  it.each([['inside a line', 0], ['on a line start', 1]])(
    'a tail window and the bytes before it are every message once, the window starting %s (2026-11-16)', async (_where, onLineStart) => {
    _resetHistoryPagesForTests();
    _resetHistoryCacheForTesting();
    const sid = `cold-tail-seam-${onLineStart}`;
    const lines = [
      ...padding(60),
      userLine('cold newest question', '2026-01-02T00:00:00.000Z'),
      asstLine('cold newest answer', '2026-01-02T00:00:05.000Z'),
    ];
    await writeLines(sid, lines);
    const size = (await fsp.stat(jsonlPath(sid))).size;
    let windowBytes = 4096;
    if (onLineStart) {
      // Pick the window so its first byte is the first byte of a line.
      const text = await fsp.readFile(jsonlPath(sid), 'utf8');
      const lineStart = text.indexOf('\n', size - 4096) + 1;
      windowBytes = size - lineStart;
    }
    const tail = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true, maxColdReadBytes: windowBytes });
    expect(isWindowedHistory(tail)).toBe(true);
    // The window's own lines begin right after the first newline at or past its first byte.
    const bytes = await fsp.readFile(jsonlPath(sid));
    expect(historyWindowStart(tail)?.byte).toBe(bytes.indexOf(0x0a, size - windowBytes) + 1);
    const page = await readSessionHistoryBefore(sid, CWD, undefined, tail[0].timestamp,
      { minMessages: 0, minText: 10_000, isText: () => true }, historyWindowStart(tail));
    expect(page?.reachedStart).toBe(true);
    const full = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect([...page!.messages, ...tail].map(m => m.text)).toEqual(full.map(m => m.text));
  });

  it('a full read carries no window start', async () => {
    const sid = 'cold-tail-no-start';
    await writeLines(sid, [userLine('only question', '2026-01-02T00:00:00.000Z'), asstLine('only answer', '2026-01-02T00:00:05.000Z')]);
    const full = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(historyWindowStart(full)).toBeUndefined();
  });

  it('a cold read over the bound serves a windowed tail with the newest messages', async () => {
    const sid = 'cold-tail-1';
    await writeLines(sid, [
      ...padding(60),
      userLine('cold newest question', '2026-01-02T00:00:00.000Z'),
      asstLine('cold newest answer', '2026-01-02T00:00:05.000Z'),
    ]);
    // NO ceiling override: the file is comfortably under maxReadBytes — the old
    // code did a full read here. The cold-read bound alone must window it.
    const messages = await readSessionHistory(sid, CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 4096 });

    expect(isWindowedHistory(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(122); // strictly fewer than the file holds
    const texts = messages.map(m => m.text);
    expect(texts).toContain('cold newest question');
    expect(texts).toContain('cold newest answer');
  });

  it('a full-read caller is never served the windowed cache entry', async () => {
    const sid = 'cold-tail-2';
    const lines = [
      ...padding(60),
      userLine('quarantine newest', '2026-01-02T00:00:00.000Z'),
    ];
    await writeLines(sid, lines);
    const windowed = await readSessionHistory(sid, CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 4096 });
    expect(isWindowedHistory(windowed)).toBe(true);

    // Same mtime, but the caller wants the FULL history (Load earlier / fork
    // ancestor read) — must fall through to the real full read, not the cache.
    const full = await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(isWindowedHistory(full)).toBe(false);
    expect(full.length).toBe(121); // 60 padding pairs + the newest line
    expect(full.length).toBeGreaterThan(windowed.length);
  });

  it('a small first-paint window cannot satisfy the larger refresh window', async () => {
    const sid = 'preview-then-refresh';
    await writeLines(sid, padding(100));
    // Above the full-read ceiling prevents the background warmer from masking the cache bug.
    process.env.WALNUT_MAX_FILE_READ_BYTES = '16384';
    const preview = await readSessionHistory(sid, CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 2048 });
    const refreshed = await readSessionHistory(sid, CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 16384 });
    expect(isWindowedHistory(preview)).toBe(true);
    expect(isWindowedHistory(refreshed)).toBe(true);
    expect(refreshed.length).toBeGreaterThan(preview.length);
    expect(refreshed.at(-1)?.msgId).toBe(preview.at(-1)?.msgId);
    _resetHistoryCacheForTesting();
    const small = await readSessionHistory(sid, CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 2048 });
    const sweep = await readSessionHistoryTail(sid, CWD, undefined, undefined, 16384);
    expect(sweep!.length).toBeGreaterThan(small.length);
  });

  it('a late smaller preview cannot replace the fresh larger refresh cache', async () => {
    const sid = 'late-preview-cache';
    await writeLines(sid, padding(100));
    process.env.WALNUT_MAX_FILE_READ_BYTES = '16384';
    delayedRanges.small = true;
    let release!: () => void;
    delayedRanges.release = new Promise<void>(r => { release = r; });
    const entered = new Promise<void>(r => { delayedRanges.entered = r; });
    const preview = readSessionHistory(sid, CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 2048 });
    try {
      await entered;
      const full = await readSessionHistory(sid, CWD, undefined, undefined,
        { skipSubagents: true, maxColdReadBytes: 16384 });
      release();
      await preview;
      // A small caller now gets the more complete, current entry, not the late preview.
      const kept = await readSessionHistory(sid, CWD, undefined, undefined,
        { skipSubagents: true, maxColdReadBytes: 2048 });
      expect(kept.length).toBe(full.length);
    } finally {
      release();
      await preview;
    }
  });

  it('a file under the bound takes the normal full read (not windowed)', async () => {
    const sid = 'cold-tail-3';
    await writeLines(sid, [userLine('hi', '2026-01-01T00:00:00.000Z'), asstLine('hello', '2026-01-01T00:00:01.000Z')]);
    const messages = await readSessionHistory(sid, CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 4 * 1024 * 1024 });
    expect(isWindowedHistory(messages)).toBe(false);
    expect(messages.length).toBe(2);
  });
});
