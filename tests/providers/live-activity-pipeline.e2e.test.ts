/**
 * A running task's live action through the real provider pipeline:
 *   ClaudeCodeSession.send() → mock daemon spawns mock-claude.mjs → stream JSONL
 *   → handleStreamLine → LiveActivityTracker → the registry → session:live-activity.
 *
 * The mock's `stream-partial-work` mode streams reasoning, a Bash call that RUNS for
 * chunk-delay x 20 before its result, reasoning, a Read that runs, then the answer.
 * What this pins: the registry names the Bash call (with its command) while it runs,
 * then the Read; the frames on the bus are throttled (a few, never one per token);
 * the turn's end clears the action at once.
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
import { liveActivityForTask, resetLiveActivity } from '../../src/core/sessions/live-activity-registry.js';
import type { LiveActivity } from '../../src/core/live-activity.js';

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs');
let daemon: MockDaemon;

beforeEach(async () => {
  bus.clear();
  resetQueueCache();
  resetLiveActivity();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true });
  daemon = await createMockDaemon();
});

afterEach(async () => {
  bus.clear();
  resetLiveActivity();
  await new Promise((r) => setTimeout(r, 200));
  await daemon.stop().catch(() => {});
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
});

async function until<T>(read: () => T | undefined, label: string, timeoutMs = 25_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('live activity pipeline (a turn with two running tool calls)', () => {
  it('names the running call, throttles the frames, and clears at the turn end', async () => {
    const frames: Array<{ sessionId: string; taskId: string | null; activity: LiveActivity | null }> = [];
    const results: BusEvent[] = [];
    bus.subscribe('web-ui', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_LIVE_ACTIVITY) frames.push(e.data as (typeof frames)[number]);
    });
    bus.subscribe('main-ai', (e: BusEvent) => { if (e.name === EventNames.SESSION_RESULT) results.push(e); });

    const session = new ClaudeCodeSession('task-live', 'proj', MOCK_CLI);
    session._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`;
    // Each call runs 250ms x 20 = 5s, the length of one throttle window.
    session.send('chunk-delay:250 stream-partial-work');

    const bash = await until(() => {
      const a = liveActivityForTask('task-live');
      return a?.kind === 'tool' && a.tool === 'Bash' ? a : undefined;
    }, 'the Bash call');
    expect(bash.target).toBe('ls -la');
    expect(bash.turnStartedAt).toBeTypeOf('string');
    expect(Date.parse(bash.since)).toBeGreaterThanOrEqual(Date.parse(bash.turnStartedAt!));
    expect(bash.sessionId).toBeTruthy();

    const read = await until(() => {
      const a = liveActivityForTask('task-live');
      return a?.tool === 'Read' ? a : undefined;
    }, 'the Read call');
    expect(read.target).toBe('mock-work/README.md');
    expect(Date.parse(read.lastToolAt!)).toBeGreaterThan(Date.parse(bash.lastToolAt!));

    await until(() => (results.length > 0 ? true : undefined), 'the turn result');
    await until(() => (liveActivityForTask('task-live') === undefined ? true : undefined), 'the clear');
    await until(() => (frames.at(-1)?.activity === null ? true : undefined), 'the clearing frame');

    // A whole turn of streamed reasoning and text is a handful of frames, not one per token.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.length).toBeLessThanOrEqual(8);
    expect(new Set(frames.map((f) => f.taskId))).toEqual(new Set(['task-live']));
    expect(frames.some((f) => f.activity?.tool === 'Bash' || f.activity?.tool === 'Read')).toBe(true);
  }, 60_000);
});
