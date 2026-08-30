/**
 * Integration test for the IN-PLACE rewind cut on the real readSessionHistory
 * path (not just the pure applyInPlaceRewindCuts). It proves the whole chain:
 * getSessionByClaudeId → getInPlaceRewindCuts → split → applyInPlaceRewindCuts
 * → parse, so a transcript that legitimately holds two branches (the CLI keeps
 * both under one session id after `--resume-session-at` without --fork-session)
 * renders only the surviving branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';
import type { InPlaceRewindCut } from '../../src/core/types.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

// The read path asks the tracker for the session's committed cuts. Drive it
// from a mutable holder so each test sets its own record.
let mockRecord: { inPlaceRewinds?: InPlaceRewindCut[] } | undefined;
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async () => mockRecord),
}));

import { CLAUDE_HOME } from '../../src/constants.js';
import {
  encodeProjectPath,
  readSessionHistory,
  historyLineCheckOf,
  splitTranscriptLines,
  _resetHistoryCacheForTesting,
} from '../../src/core/session-history.js';

const tmpBase = CLAUDE_HOME;
const CWD = '/proj/rewind';

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  _resetHistoryCacheForTesting();
  mockRecord = undefined;
});
afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

const userLine = (uuid: string, text: string) => JSON.stringify({
  type: 'user', uuid, timestamp: '2026-08-30T00:00:00.000Z',
  message: { role: 'user', content: text },
});
const asstLine = (uuid: string, id: string, text: string) => JSON.stringify({
  type: 'assistant', uuid, timestamp: '2026-08-30T00:00:01.000Z',
  message: { role: 'assistant', id, content: [{ type: 'text', text }] },
});

async function writeRaw(sessionId: string, lines: string[]) {
  const dir = path.join(tmpBase, 'projects', encodeProjectPath(CWD));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.join('\n'));
}

describe('readSessionHistory applies in-place rewind cuts', () => {
  it('hides the abandoned branch and keeps the new one', async () => {
    const U1 = '0199aa01-0000-4000-8000-000000000001';
    const U2 = '0199aa01-0000-4000-8000-000000000002';
    // Original branch: U1 A1 U2 A2 U3 A3 (6 lines). Rewound to U2 (index 2).
    const original = [
      userLine(U1, 'set up the project'),
      asstLine('0199aa01-0000-4000-8000-0000000000a1', 'msg_a1', 'done setup'),
      userLine(U2, 'add a feature'),
      asstLine('0199aa01-0000-4000-8000-0000000000a2', 'msg_a2', 'ABANDONED reply two'),
      userLine('0199aa01-0000-4000-8000-000000000003', 'ABANDONED third ask'),
      asstLine('0199aa01-0000-4000-8000-0000000000a3', 'msg_a3', 'ABANDONED reply three'),
    ];
    // New branch appended after the rewind: U2' A2'.
    const withBranch = [
      ...original,
      userLine('0199aa01-0000-4000-8000-000000000012', 'add a DIFFERENT feature'),
      asstLine('0199aa01-0000-4000-8000-0000000000b2', 'msg_b2', 'NEW reply two'),
    ];
    const cut: InPlaceRewindCut = {
      uuid: U2,
      targetLine: 2,
      afterLine: 6,
      targetCheck: historyLineCheckOf(original[2]),
      lastCheck: historyLineCheckOf(original[5]),
      at: '2026-08-30T00:00:00.000Z',
    };
    mockRecord = { inPlaceRewinds: [cut] };
    await writeRaw('s-rw', withBranch);

    const messages = await readSessionHistory('s-rw', CWD);
    const texts = messages.map((m) => m.text);
    // Surviving: setup, done setup, add-feature, new branch. No ABANDONED text.
    expect(texts.some((t) => t.includes('ABANDONED'))).toBe(false);
    expect(texts).toContain('add a feature');
    expect(texts).toContain('add a DIFFERENT feature');
    expect(texts).toContain('NEW reply two');
  });

  it('serves the full transcript when a cut fingerprint no longer matches', async () => {
    const U1 = '0199aa02-0000-4000-8000-000000000001';
    const lines = [
      userLine(U1, 'first'),
      asstLine('0199aa02-0000-4000-8000-0000000000a1', 'msg_a1', 'reply one'),
      userLine('0199aa02-0000-4000-8000-000000000002', 'DROP ME candidate'),
    ];
    // Cut points at line 0 but records a stale fingerprint (as if /compact
    // rewrote the file) → filtering must be abandoned, full transcript served.
    const cut: InPlaceRewindCut = {
      uuid: U1, targetLine: 0, afterLine: 3,
      targetCheck: { len: 99, head: 'stale', tail: 'stale' },
      lastCheck: historyLineCheckOf(lines[2]),
      at: '2026-08-30T00:00:00.000Z',
    };
    mockRecord = { inPlaceRewinds: [cut] };
    await writeRaw('s-stale', lines);

    const messages = await readSessionHistory('s-stale', CWD);
    expect(messages.map((m) => m.text)).toContain('DROP ME candidate');
  });

  it('is a no-op read for a session with no cuts (unfiltered)', async () => {
    const lines = [
      userLine('0199aa03-0000-4000-8000-000000000001', 'keep everything'),
      asstLine('0199aa03-0000-4000-8000-0000000000a1', 'msg_a1', 'sure'),
    ];
    mockRecord = {}; // record exists, no inPlaceRewinds
    await writeRaw('s-none', lines);
    const messages = await readSessionHistory('s-none', CWD);
    expect(messages.map((m) => m.text)).toEqual(['keep everything', 'sure']);
    // splitTranscriptLines is the recorder/applier's shared split — sanity that
    // the raw file split matches what the cut indices were recorded against.
    expect(splitTranscriptLines(lines.join('\n'))).toHaveLength(2);
  });
});
