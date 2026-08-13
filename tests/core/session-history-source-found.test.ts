/**
 * "The transcript EXISTS" vs "the parse produced rows" — two different facts.
 *
 * Conflating them is what made every task creation flash "History unavailable —
 * Session history file not found" on a perfectly healthy, running session. A
 * just-spawned CLI writes `system`/hook lines first, so for the first seconds its
 * JSONL exists and grows while parseSessionMessages legitimately returns [] —
 * and readProviderSessionHistory's old `sourceAvailable: messages.length > 0`
 * proxy read that as a MISSING FILE.
 *
 * These drive the REAL read pipeline (readSessionHistory over a mocked local
 * daemon reader against real files on disk), so they pin the fact at the layer
 * that produces it rather than at a route mock.
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
  isSourceFoundHistory,
  _resetHistoryCacheForTesting,
} from '../../src/core/session-history.js';
import { readProviderSessionHistory } from '../../src/core/sessions/session-lifecycle.js';
import type { SessionRecord } from '../../src/core/types.js';

const tmpBase = CLAUDE_HOME as string;
const CWD = '/tmp/source-found-test-project';

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  _resetHistoryCacheForTesting();
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

function jsonlPath(sessionId: string): string {
  return path.join(tmpBase, 'projects', encodeProjectPath(CWD), `${sessionId}.jsonl`);
}

async function writeRaw(sessionId: string, content: string): Promise<void> {
  const p = jsonlPath(sessionId);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
}

function record(sessionId: string): SessionRecord {
  return {
    claudeSessionId: sessionId,
    taskId: 'task-1',
    project: 'proj',
    process_status: 'running',
    mode: 'default',
    startedAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messageCount: 0,
    cwd: CWD,
  };
}

/** Exactly what a booting CLI writes before its first real message. */
const BOOT_ONLY_JSONL = [
  JSON.stringify({ type: 'system', subtype: 'hook_started', hook_id: 'h-1', hook_name: 'SessionStart:startup' }),
  JSON.stringify({ type: 'system', subtype: 'hook_completed', hook_id: 'h-1' }),
].join('\n') + '\n';

describe('isSourceFoundHistory — transcript existence is independent of message count', () => {
  it('is TRUE for a transcript that exists but parses to zero messages (session still booting)', async () => {
    await writeRaw('boot-only', BOOT_ONLY_JSONL);

    const messages = await readSessionHistory('boot-only', CWD, undefined, undefined, { skipSubagents: true });

    expect(messages).toEqual([]);
    // The whole point: empty parse, but the file is right there on disk.
    expect(isSourceFoundHistory(messages)).toBe(true);
  });

  it('is FALSE when no transcript file exists at all', async () => {
    const messages = await readSessionHistory('never-existed', CWD, undefined, undefined, { skipSubagents: true });

    expect(messages).toEqual([]);
    expect(isSourceFoundHistory(messages)).toBe(false);
  });

  it('is TRUE for a normal transcript with messages', async () => {
    await writeRaw('has-msgs', [
      JSON.stringify({
        type: 'user', uuid: 'u-1', timestamp: '2026-08-09T00:00:00Z',
        message: { role: 'user', content: 'hello' },
      }),
    ].join('\n') + '\n');

    const messages = await readSessionHistory('has-msgs', CWD, undefined, undefined, { skipSubagents: true });

    expect(messages.length).toBe(1);
    expect(isSourceFoundHistory(messages)).toBe(true);
  });

  it('survives the mtime cache hit path (second read of the same booting session)', async () => {
    await writeRaw('boot-cached', BOOT_ONLY_JSONL);

    const first = await readSessionHistory('boot-cached', CWD, undefined, undefined, { skipSubagents: true });
    const second = await readSessionHistory('boot-cached', CWD, undefined, undefined, { skipSubagents: true });

    expect(isSourceFoundHistory(first)).toBe(true);
    // The cache-hit return is a DIFFERENT hand-off of the same array — the flag
    // must be stamped there too, or the second poll re-reports "file not found".
    expect(second).toEqual([]);
    expect(isSourceFoundHistory(second)).toBe(true);
  });
});

describe('readProviderSessionHistory.sourceAvailable', () => {
  it('reports the booting session as AVAILABLE despite zero parsed messages', async () => {
    await writeRaw('provider-boot', BOOT_ONLY_JSONL);

    const res = await readProviderSessionHistory('provider-boot', record('provider-boot'), undefined);

    expect(res.messages).toEqual([]);
    // Before the fix this was `false`, and the route turned it into
    // "History unavailable — Session history file not found".
    expect(res.sourceAvailable).toBe(true);
  });

  it('reports a genuinely missing transcript as UNAVAILABLE', async () => {
    const res = await readProviderSessionHistory('provider-missing', record('provider-missing'), undefined);

    expect(res.messages).toEqual([]);
    expect(res.sourceAvailable).toBe(false);
  });
});
