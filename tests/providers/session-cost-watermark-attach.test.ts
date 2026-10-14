/** Same-process watermarks and restored transcript baselines must never rebill history. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
// attachToExisting reads stream evidence through the daemon file reader; the
// mock keeps that host-local and stops the test from spawning a real daemon.
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME, SESSION_STREAMS_DIR, CLAUDE_HOME } from '../../src/constants.js';
import { createSessionRecord, updateSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';
import type { SessionRecord } from '../../src/core/types.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs');
let daemon: MockDaemon;

interface Internals {
  _transport: unknown;
  _active: boolean;
  _processStatus: string;
  handleStreamLine(line: string, v?: number): void;
  detach(): void;
}

function resultLine(sid: string, totalCost: number): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 1500, num_turns: 1,
    result: 'Done', session_id: sid, total_cost_usd: totalCost,
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

/** Persist a record for `sid` running as `pid` (plus any spilled fields) and return it. */
async function makeRecord(sid: string, pid: number, extra: Partial<SessionRecord> = {}): Promise<SessionRecord> {
  await createSessionRecord(sid, `task-${sid}`, 'proj', '/tmp', { pid, outputFile: '/tmp/nonexistent.jsonl', messageCount: 1 });
  return Object.keys(extra).length ? updateSessionRecord(sid, extra) : (await getSessionByClaudeId(sid))!;
}

/** Attach, make the instance believe its process is live, and return it. */
async function attach(record: SessionRecord): Promise<ClaudeCodeSession & Internals> {
  const session = await ClaudeCodeSession.attachToExisting(record, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`) as ClaudeCodeSession & Internals;
  session._transport = {
    isRemote: false, hasPipe: true, processName: 'claude', pid: record.pid ?? null,
    outputFile: record.outputFile ?? null, host: null, fileSize: 0,
    imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
    stopTail() {}, startTail() {}, detach() {},
  };
  session._active = true;
  session._processStatus = 'running';
  return session;
}

function collectCostDeltas(): number[] {
  const deltas: number[] = [];
  bus.subscribe('main-ai', (e: BusEvent) => {
    if (e.name === EventNames.SESSION_RESULT) deltas.push((e.data as { costDelta: number }).costDelta);
  });
  return deltas;
}

beforeAll(async () => { daemon = await createMockDaemon(); });
afterAll(async () => { await daemon.stop().catch(() => {}); });

beforeEach(async () => {
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true });
});

afterEach(async () => {
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
});

describe('cost watermark across runner re-creation', () => {
  it('a different PID restores the CLI cost-state instead of rebilling history', async () => {
    const sid = 'cw-restored';
    const dir = path.join(CLAUDE_HOME, 'projects', '-tmp');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${sid}.jsonl`), JSON.stringify({
      type: 'cost-state', sessionId: sid, totalCostUSD: 690,
      totalAPIDuration: 1, totalAPIDurationWithoutRetries: 1, totalToolDuration: 1,
      totalLinesAdded: 0, totalLinesRemoved: 0, totalDuration: 1, startTime: 1,
      modelUsage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 1, thinkingTokens: 0,
        cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 690 } },
      hasUnknownModelCost: false,
    }) + '\n');
    const session = await attach(await makeRecord(sid, 5151, { costWatermark: 690, costWatermarkPid: 4242 }));
    const deltas = collectCostDeltas();
    session.handleStreamLine(resultLine(sid, 690.25), 2000);
    await vi.waitFor(() => expect(deltas).toEqual([expect.closeTo(0.25, 6)]));
    session.detach();
  });
  it('a result persists the charged total next to the process pid', async () => {
    const sid = 'cw-persist';
    const session = await attach(await makeRecord(sid, 4242, { costWatermark: 0, costWatermarkPid: 4242 }));
    const deltas = collectCostDeltas();

    session.handleStreamLine(resultLine(sid, 0.15), 1000);
    await vi.waitFor(() => expect(deltas).toEqual([expect.closeTo(0.15, 6)]), { timeout: 2000, interval: 25 });

    await vi.waitFor(async () => {
      const record = await getSessionByClaudeId(sid);
      expect(record?.costWatermark).toBeCloseTo(0.15, 6);
      expect(record?.costWatermarkPid).toBe(4242);
    }, { timeout: 2000, interval: 25 });
    session.detach();
  });

  it('re-attaching to the SAME process charges the next result as an increment', async () => {
    const sid = 'cw-same-pid';
    const session = await attach(await makeRecord(sid, 4242, { costWatermark: 0.15, costWatermarkPid: 4242 }));
    const deltas = collectCostDeltas();

    // The process total climbed from 0.15 (charged by the previous instance) to 0.178.
    session.handleStreamLine(resultLine(sid, 0.178), 2000);
    await vi.waitFor(() => expect(deltas).toEqual([expect.closeTo(0.028, 6)]), { timeout: 2000, interval: 25 });
    session.detach();
  });

  it('does not bill the first restored total when its baseline is unavailable', async () => {
    const sid = 'cw-new-pid';
    const session = await attach(await makeRecord(sid, 5151, { costWatermark: 0.15, costWatermarkPid: 4242 }));
    const deltas = collectCostDeltas();
    session.handleStreamLine(resultLine(sid, 690.02), 3000);
    await vi.waitFor(() => expect(deltas).toEqual([0]), { timeout: 2000, interval: 25 });
    session.detach();
  });

  it('a corrupt persisted watermark leaves the first restored cost unverified', async () => {
    const sid = 'cw-corrupt';
    const session = await attach(await makeRecord(sid, 4242, { costWatermark: Number.NaN, costWatermarkPid: 4242 }));
    const deltas = collectCostDeltas();

    session.handleStreamLine(resultLine(sid, 0.05), 4000);
    await vi.waitFor(() => expect(deltas).toEqual([0]), { timeout: 2000, interval: 25 });
    session.detach();
  });
});
