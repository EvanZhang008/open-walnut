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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  readSessionHistory,
  isWindowedHistory,
  _resetHistoryCacheForTesting,
} from '../../src/core/session-history.js';
import { registerEchoClaims, _resetEchoClaimsForTest } from '../../src/core/echo-claims.js';

const tmpBase = CLAUDE_HOME as string;
const CWD = '/tmp/windowed-test-project';
const prevLimit = process.env.WALNUT_MAX_FILE_READ_BYTES;

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  _resetHistoryCacheForTesting();
  _resetEchoClaimsForTest();
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  if (prevLimit === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES;
  else process.env.WALNUT_MAX_FILE_READ_BYTES = prevLimit;
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

  it('a file under the bound takes the normal full read (not windowed)', async () => {
    const sid = 'cold-tail-3';
    await writeLines(sid, [userLine('hi', '2026-01-01T00:00:00.000Z'), asstLine('hello', '2026-01-01T00:00:01.000Z')]);
    const messages = await readSessionHistory(sid, CWD, undefined, undefined,
      { skipSubagents: true, maxColdReadBytes: 4 * 1024 * 1024 });
    expect(isWindowedHistory(messages)).toBe(false);
    expect(messages.length).toBe(2);
  });
});
