/**
 * The stream-convergence sentinel reads persisted history 15 s after every turn.
 * It used to call readSessionHistory with no options, which missed the UI's
 * append-only read and read the WHOLE transcript every time: 45 of 92 full reads
 * (541 of 737 MB) in 2.7 h on 2026-10-26. These tests run the real
 * session-history parser over a temp JSONL and pin that the sentinel's read after
 * a turn takes the append path (no whole-file readFile) and still judges right.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

const mocks = vi.hoisted(() => ({
  getSessionByClaudeId: vi.fn(),
  createIncident: vi.fn(),
}));

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: mocks.getSessionByClaudeId,
}));
vi.mock('../../src/core/observability/incidents.js', () => ({
  createIncident: mocks.createIncident,
}));

import { CLAUDE_HOME } from '../../src/constants.js';
import { DaemonFileReader } from '../../src/core/daemon-file-reader.js';
import { log } from '../../src/logging/index.js';
import {
  encodeProjectPath,
  readSessionHistory,
  _resetHistoryCacheForTesting,
  _historyCacheGetForTesting,
} from '../../src/core/session-history.js';
import { armStreamConvergenceCheck } from '../../src/core/observability/stream-convergence.js';

const CWD = '/tmp/convergence-inc-project';

function jsonlPath(sessionId: string): string {
  return path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${sessionId}.jsonl`);
}

let n = 0;
const userLine = (text: string) => ({
  type: 'user', uuid: `u-${++n}`, timestamp: new Date().toISOString(),
  message: { role: 'user', content: text },
});
const assistantLine = (text: string, id: string) => ({
  type: 'assistant', uuid: `a-${++n}`, timestamp: new Date().toISOString(),
  message: { id, role: 'assistant', content: [{ type: 'text', text }] },
});
const toJsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

async function bumpMtime(sessionId: string): Promise<void> {
  const future = new Date(Date.now() + 5_000 + Math.floor(Math.random() * 50_000));
  await fsp.utimes(jsonlPath(sessionId), future, future);
}

async function runSentinel(sessionId: string, streamed: string[]): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    armStreamConvergenceCheck(sessionId, streamed);
    await vi.advanceTimersByTimeAsync(15_000);
  } finally {
    vi.useRealTimers();
  }
  // The check's dynamic imports and real file reads settle on real timers.
  await vi.waitFor(() => expect(mocks.getSessionByClaudeId).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 200));
}

describe('stream-convergence sentinel read after a turn', () => {
  beforeEach(async () => {
    await fsp.rm(CLAUDE_HOME, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(jsonlPath('x')), { recursive: true });
    _resetHistoryCacheForTesting();
    mocks.getSessionByClaudeId.mockReset().mockResolvedValue({ cwd: CWD, host: undefined, taskId: 't1' });
    mocks.createIncident.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('takes the append path the UI seeded: no whole-file read, and the new turn converges', async () => {
    const sid = 'conv-inc-ok';
    await fsp.writeFile(jsonlPath(sid), toJsonl([userLine('first'), assistantLine('one', 'msg_1')]));
    // The UI's read seeds the incremental state.
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });
    expect(_historyCacheGetForTesting(sid)?.inc).toBeDefined();

    // The turn appends; the sentinel then checks the ids it streamed.
    await fsp.appendFile(jsonlPath(sid), toJsonl([userLine('second'), assistantLine('two', 'msg_2')]));
    await bumpMtime(sid);
    const fullRead = vi.spyOn(DaemonFileReader.prototype, 'readFile');
    const range = vi.spyOn(DaemonFileReader.prototype, 'readFileRange');
    const warn = vi.spyOn(log.obs, 'warn');
    const debug = vi.spyOn(log.obs, 'debug');

    await runSentinel(sid, ['msg_2']);

    expect(fullRead).not.toHaveBeenCalled();
    expect(range).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('stream-convergence: converged', expect.objectContaining({ sessionId: sid, checked: 1 }));
  });

  it('on the append path a streamed id that never persisted is still flagged', async () => {
    const sid = 'conv-inc-miss';
    await fsp.writeFile(jsonlPath(sid), toJsonl([userLine('first'), assistantLine('one', 'msg_1')]));
    await readSessionHistory(sid, CWD, undefined, undefined, { skipSubagents: true });

    await fsp.appendFile(jsonlPath(sid), toJsonl([userLine('second'), assistantLine('two', 'msg_2')]));
    await bumpMtime(sid);
    const fullRead = vi.spyOn(DaemonFileReader.prototype, 'readFile');
    const warn = vi.spyOn(log.obs, 'warn');

    await runSentinel(sid, ['msg_2', 'msg_lost']);

    expect(fullRead).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('partial, case file only'),
      expect.objectContaining({ sessionId: sid, missing: ['msg_lost'], checked: 2 }),
    );
  });
});
