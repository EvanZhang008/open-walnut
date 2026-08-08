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
