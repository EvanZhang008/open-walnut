/**
 * The turn speed readout through the real provider pipeline:
 *   ClaudeCodeSession.send() → mock daemon spawns mock-claude.mjs → stream_event
 *   JSONL → handleStreamLine → TurnSpeedMeter → session:turn-speed frames on
 *   the bus + the final numbers on session:result.
 *
 * The mock's `stream-partial-speed` mode is two API messages with a tool gap
 * between them (see mock-claude.mjs). What this pins:
 *   - live frames arrive while the turn runs and a final frame closes it;
 *   - tokens are the CLI's counts (30 + 20 = 50), never a character estimate;
 *   - generation time excludes the tool gap, so tok/s reads well above the
 *     wall-clock rate;
 *   - session:result carries usage, model and the same final speed for the
 *     usage ledger row.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
import { resetCache as resetQueueCache } from '../../src/core/session-message-queue.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';
import type { SessionTurnSpeed } from '../../src/core/types.js';
import { tokensPerSecond } from '../../src/core/sessions/turn-speed.js';

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs');

let daemon: MockDaemon;

function newSession(taskId: string): ClaudeCodeSession {
  const session = new ClaudeCodeSession(taskId, 'proj', MOCK_CLI);
  session._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`;
  return session;
}

interface Collected {
  speeds: Array<{ sessionId: string; speed: SessionTurnSpeed }>;
  results: BusEvent[];
  errors: BusEvent[];
}

function makeCollector(): Collected {
  const c: Collected = { speeds: [], results: [], errors: [] };
  bus.subscribe('web-ui', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_TURN_SPEED) {
      c.speeds.push(event.data as { sessionId: string; speed: SessionTurnSpeed });
    }
  });
  bus.subscribe('main-ai', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_RESULT) c.results.push(event);
    if (event.name === EventNames.SESSION_ERROR) c.errors.push(event);
  });
  return c;
}

function waitForResult(c: Collected, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (c.results.length > 0 || c.errors.length > 0) { setTimeout(resolve, 150); return; }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for result; speed frames=${c.speeds.length}`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

beforeEach(async () => {
  bus.clear();
  resetQueueCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true });
  daemon = await createMockDaemon();
});

afterEach(async () => {
  bus.clear();
  await new Promise((r) => setTimeout(r, 200));
  await daemon.stop().catch(() => {});
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
});

describe('turn speed pipeline (two messages with a tool gap)', () => {
  it('streams live frames, closes with the CLI counts, and excludes the tool gap from generation', async () => {
    const c = makeCollector();
    const session = newSession('task-speed');
    // 120ms between deltas: two message windows of ~600ms (5 pauses each) around a
    // 2.4s tool gap; the mock reports duration_ms = 30 pauses.
    session.send('chunk-delay:120 stream-partial-speed');

    await waitForResult(c);
    // The mock exits right after its result; the harness sometimes reports that
    // exit as a process error AFTER the result, which is not this test's subject.
    expect(c.results).toHaveLength(1);

    const live = c.speeds.filter((f) => !f.speed.final);
    const finals = c.speeds.filter((f) => f.speed.final);
    expect(live.length, 'live frames while the turn ran').toBeGreaterThanOrEqual(2);
    expect(finals, 'exactly one final frame').toHaveLength(1);
    const final = finals[0].speed;
    // Every frame names the same session.
    expect(new Set(c.speeds.map((f) => f.sessionId)).size).toBe(1);

    // The very first frame is the turn-start edge: live, nothing seen yet, so a
    // panel flips to its ticking clocks at the send rather than at the first delta.
    expect(live[0].speed).toMatchObject({ messages: 0, inFlight: false, ttftMs: null, outputTokens: 0 });
    expect(live[0].speed.startedAt).toBeTypeOf('number');

    // The first live frame after the first message boundary carries that
    // message's real count; the estimate lives only in inFlightChars.
    const afterFirstMessage = live.find((f) => f.speed.messages === 1);
    expect(afterFirstMessage?.speed.outputTokens).toBe(30);
    expect(afterFirstMessage?.speed.model).toBe('mock-model');

    // Final: CLI counts, both messages, a ttft, a cost, the CLI's wall time.
    expect(final.outputTokens).toBe(50);
    expect(final.turnOutputTokens).toBe(50);
    expect(final.messages).toBe(2);
    expect(final.inFlight).toBe(false);
    expect(final.ttftMs).not.toBeNull();
    expect(final.ttftMs!).toBeGreaterThan(0);
    expect(final.durationMs).toBe(120 * 30);
    expect(final.costUsd).toBeCloseTo(0.0123, 6);
    expect(final.costEstimated).toBeUndefined();
    expect(final.partial).toBeUndefined();
    expect(final.interrupted).toBeUndefined();

    // Generation: two windows of message_start → message_stop, 5 pauses each
    // (~1.2s nominal, measured up to ~1.5s under load), never the 2.4s tool gap.
    // The bound leaves the windows a full gap-half of timer slack, and the rate
    // must still beat the wall-clock rate by a clear margin.
    expect(final.generationMs).toBeGreaterThanOrEqual(800);
    expect(final.generationMs).toBeLessThan(120 * 30 - 120 * 10);
    const tps = tokensPerSecond(final)!;
    const wallRate = 50 / ((120 * 30) / 1000);
    expect(tps).toBeGreaterThan(wallRate * 1.1);

    // The result event hands the ledger the same numbers.
    const result = c.results[0].data as {
      usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
      model?: string;
      speed?: SessionTurnSpeed;
      costDelta?: number;
    };
    expect(result.usage).toEqual({ input_tokens: 26, output_tokens: 50, cache_read_input_tokens: 1612, cache_creation_input_tokens: 0 });
    expect(result.model).toBe('mock-model');
    expect(result.speed).toEqual(final);
    expect(result.costDelta).toBeCloseTo(0.0123, 6);

    // The record keeps the final frame for a cold load, and the charged total
    // next to the pid of the process it was charged for, so a runner re-created
    // for that same process bills its next turn as an increment, not the whole
    // total again. (The mock exits after its result, so the record's live pid
    // is already cleared here; the watermark's pid stays as evidence.)
    const { getSessionsForTask } = await import('../../src/core/session-tracker.js');
    await vi.waitFor(async () => {
      const [record] = await getSessionsForTask('task-speed');
      expect(record?.lastTurnSpeed).toEqual(final);
      expect(record?.costWatermark).toBeCloseTo(0.0123, 6);
      expect(record?.costWatermarkPid).toBeGreaterThan(0);
    }, { timeout: 3000, interval: 50 });
  });

  it('a turn without partial messages still closes with the CLI usage and no rate', async () => {
    const c = makeCollector();
    const session = newSession('task-plain');
    // The default mock turn: a consolidated assistant line and a result, no stream_events.
    session.send('hello');

    await waitForResult(c);
    // The mock exits right after its result; the harness may report that exit
    // as a process error after the result, which is not this test's subject.
    expect(c.results.length).toBeGreaterThanOrEqual(1);
    const finals = c.speeds.filter((f) => f.speed.final);
    expect(finals).toHaveLength(1);
    const final = finals[0].speed;
    expect(final.messages).toBe(0);
    expect(final.generationMs).toBe(0);
    expect(final.ttftMs).toBeNull();
    expect(tokensPerSecond(final)).toBeNull();
    expect(final.turnOutputTokens).toBe((c.results[0].data as { usage?: { output_tokens: number } }).usage?.output_tokens);
  });
});
