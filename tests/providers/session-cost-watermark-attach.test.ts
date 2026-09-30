/**
 * The cost watermark survives a runner re-creation for the SAME CLI process.
 *
 * The CLI reports `total_cost_usd` as a running total per process. The queue
 * re-creates the ClaudeCodeSession between turns (attachToExisting), and a
 * fresh instance used to start its watermark at 0, so the second turn's result
 * was charged the whole process total: the speed readout showed $0.18 for a
 * $0.03 turn, and the usage ledger over-counted the same way.
 *
 *   1. a result persists {costWatermark, costWatermarkPid} on the record
 *   2. attachToExisting seeds the watermark when the record's pid matches
 *   3. a record whose pid changed (fresh process) keeps the reset watermark
 */
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
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
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
  it('a result persists the charged total next to the process pid', async () => {
    const sid = 'cw-persist';
    const session = await attach(await makeRecord(sid, 4242));
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

  it('a record whose pid moved on (fresh process) is charged from zero', async () => {
    const sid = 'cw-new-pid';
    // The watermark was recorded for pid 4242; the session now runs as pid 5151
    // (a --resume spawned a fresh process whose total restarts at 0).
    const session = await attach(await makeRecord(sid, 5151, { costWatermark: 0.15, costWatermarkPid: 4242 }));
    const deltas = collectCostDeltas();

    session.handleStreamLine(resultLine(sid, 0.02), 3000);
    await vi.waitFor(() => expect(deltas).toEqual([expect.closeTo(0.02, 6)]), { timeout: 2000, interval: 25 });
    session.detach();
  });

  it('a corrupt persisted watermark is ignored rather than hiding spend', async () => {
    const sid = 'cw-corrupt';
    const session = await attach(await makeRecord(sid, 4242, { costWatermark: Number.NaN, costWatermarkPid: 4242 }));
    const deltas = collectCostDeltas();

    session.handleStreamLine(resultLine(sid, 0.05), 4000);
    await vi.waitFor(() => expect(deltas).toEqual([expect.closeTo(0.05, 6)]), { timeout: 2000, interval: 25 });
    session.detach();
  });
});
