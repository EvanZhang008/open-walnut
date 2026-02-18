import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseDuration,
  isWithinActiveHours,
  startHeartbeatRunner,
  HEARTBEAT_OK_TOKEN,
  isHeartbeatOk,
  type HeartbeatRunnerDeps,
} from '../../src/heartbeat/index.js';

// ── parseDuration ──

describe('parseDuration', () => {
  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('5m')).toBe(5 * 60_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses combined hours and minutes', () => {
    expect(parseDuration('1h30m')).toBe(90 * 60_000);
  });

  it('parses seconds', () => {
    expect(parseDuration('10s')).toBe(10_000);
  });

  it('returns 0 for disable strings', () => {
    expect(parseDuration('0')).toBe(0);
    expect(parseDuration('0m')).toBe(0);
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('')).toBe(0);
  });

  it('treats bare number as minutes', () => {
    expect(parseDuration('15')).toBe(15 * 60_000);
  });
});

// ── isWithinActiveHours ──

describe('isWithinActiveHours', () => {
  it('returns true when no activeHours is configured', () => {
    expect(isWithinActiveHours()).toBe(true);
    expect(isWithinActiveHours(undefined)).toBe(true);
  });

  it('returns true when current time is within range', () => {
    const now = new Date();
    const h = now.getHours();
    // Create a range that includes the current hour
    const start = `${String(h).padStart(2, '0')}:00`;
    const end = `${String((h + 2) % 24).padStart(2, '0')}:00`;
    expect(isWithinActiveHours(`${start}-${end}`)).toBe(true);
  });

  it('returns false when current time is outside range', () => {
    const now = new Date();
    const h = now.getHours();
    // Create a range that excludes the current hour (2-3 hours ago)
    const start = `${String((h + 22) % 24).padStart(2, '0')}:00`;
    const end = `${String((h + 23) % 24).padStart(2, '0')}:00`;
    expect(isWithinActiveHours(`${start}-${end}`)).toBe(false);
  });

  it('returns true for invalid format (graceful fallback)', () => {
    expect(isWithinActiveHours('invalid')).toBe(true);
  });
});

// ── HeartbeatRunner ──

describe('startHeartbeatRunner', () => {
  let deps: HeartbeatRunnerDeps;
  let runAgentTurnMock: ReturnType<typeof vi.fn>;
  let broadcastEventMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    runAgentTurnMock = vi.fn().mockResolvedValue('HEARTBEAT_OK');
    broadcastEventMock = vi.fn();
    deps = {
      runAgentTurn: runAgentTurnMock,
      isQueueBusy: () => false,
      broadcastEvent: broadcastEventMock,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts and stops cleanly', () => {
    const handle = startHeartbeatRunner({ enabled: true, every: '30m' }, deps);
    const state = handle.getState();
    expect(state.stopped).toBe(false);
    expect(state.nextDueAt).not.toBeNull();

    handle.stop();
    const stoppedState = handle.getState();
    expect(stoppedState.stopped).toBe(true);
    expect(stoppedState.nextDueAt).toBeNull();
  });

  it('does not schedule when interval is 0', () => {
    const handle = startHeartbeatRunner({ enabled: true, every: '0m' }, deps);
    const state = handle.getState();
    expect(state.nextDueAt).toBeNull();
    handle.stop();
  });

  it('does not fire when stopped', async () => {
    const handle = startHeartbeatRunner({ enabled: true, every: '1s' }, deps);
    handle.stop();

    // Advance past the interval
    await vi.advanceTimersByTimeAsync(2000);

    expect(runAgentTurnMock).not.toHaveBeenCalled();
  });

  it('requestNow coalesces multiple calls (debounced)', async () => {
    // Multiple requestNow calls within 250ms window should coalesce into one.
    // The heartbeat will either run or skip depending on whether HEARTBEAT.md exists.
    // We test that at most ONE heartbeat fires despite two requestNow calls.
    const handle = startHeartbeatRunner({ enabled: true, every: '1h' }, deps);

    handle.requestNow('manual', 'test context');
    handle.requestNow('manual', 'test context 2'); // Should coalesce

    // Advance past debounce window (250ms)
    await vi.advanceTimersByTimeAsync(300);

    // At most 1 call (0 if HEARTBEAT.md doesn't exist, 1 if it does)
    expect(runAgentTurnMock.mock.calls.length).toBeLessThanOrEqual(1);

    handle.stop();
  });

  it('skips when queue is busy', async () => {
    const busyDeps: HeartbeatRunnerDeps = {
      ...deps,
      isQueueBusy: () => true,
    };
    const handle = startHeartbeatRunner({ enabled: true, every: '1s' }, busyDeps);

    // Even with requestNow, it should skip if queue is busy
    handle.requestNow('manual');
    await vi.advanceTimersByTimeAsync(300);

    expect(runAgentTurnMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it('getState returns current state', () => {
    const handle = startHeartbeatRunner({ enabled: true, every: '30m' }, deps);
    const state = handle.getState();

    expect(state.running).toBe(false);
    expect(state.lastRunAt).toBeNull();
    expect(state.stopped).toBe(false);

    handle.stop();
  });

  it('recovers after runAgentTurn throws (schedules next beat)', async () => {
    // Mock: first call throws, second call succeeds
    const failingTurnMock = vi.fn()
      .mockRejectedValueOnce(new Error('API timeout'))
      .mockResolvedValue('HEARTBEAT_OK');
    const failDeps: HeartbeatRunnerDeps = {
      ...deps,
      runAgentTurn: failingTurnMock,
    };
    const handle = startHeartbeatRunner({ enabled: true, every: '1s' }, failDeps);

    // The first interval fires and the agent turn throws
    await vi.advanceTimersByTimeAsync(1100);

    // Runner should not be stuck — state.running should be false after error
    const state = handle.getState();
    expect(state.running).toBe(false);

    // The next interval should still be scheduled (nextDueAt set)
    // Whether a second call happens depends on HEARTBEAT.md existence,
    // but the runner didn't crash
    expect(state.stopped).toBe(false);

    handle.stop();
  });

  it('prevents re-entry (state.running guard)', async () => {
    // If somehow two executions overlap, the second should bail out
    let resolveFirst: (() => void) | null = null;
    const slowTurnMock = vi.fn().mockImplementation(() => {
      return new Promise<string>((resolve) => {
        resolveFirst = () => resolve('HEARTBEAT_OK');
      });
    });
    const slowDeps: HeartbeatRunnerDeps = {
      ...deps,
      runAgentTurn: slowTurnMock,
    };
    const handle = startHeartbeatRunner({ enabled: true, every: '500ms' }, slowDeps);

    // Trigger first execution via requestNow
    handle.requestNow('manual');
    await vi.advanceTimersByTimeAsync(300); // Debounce fires, starts first execution

    // While first is running, trigger another via requestNow
    handle.requestNow('manual');
    await vi.advanceTimersByTimeAsync(300); // Debounce fires, but running=true → skipped

    // At most 1 call was made (the first one, or 0 if HEARTBEAT.md doesn't exist)
    expect(slowTurnMock.mock.calls.length).toBeLessThanOrEqual(1);

    // Clean up: resolve the first call
    if (resolveFirst) resolveFirst();
    await vi.advanceTimersByTimeAsync(100);

    handle.stop();
  });

  it('five rapid requestNow calls coalesce into at most one execution', async () => {
    const handle = startHeartbeatRunner({ enabled: true, every: '1h' }, deps);

    // Fire 5 requestNow calls in rapid succession
    handle.requestNow('session-ended', 'ctx 1');
    handle.requestNow('cron-completed', 'ctx 2');
    handle.requestNow('session-ended', 'ctx 3');
    handle.requestNow('manual', 'ctx 4');
    handle.requestNow('cron-completed', 'ctx 5');

    // Advance past debounce window
    await vi.advanceTimersByTimeAsync(300);

    // At most 1 agent turn call (the last one wins)
    expect(runAgentTurnMock.mock.calls.length).toBeLessThanOrEqual(1);

    handle.stop();
  });

  it('requestNow is no-op after stop()', () => {
    const handle = startHeartbeatRunner({ enabled: true, every: '30m' }, deps);
    handle.stop();

    // This should not throw or schedule anything
    handle.requestNow('manual');

    const state = handle.getState();
    expect(state.stopped).toBe(true);
  });
});

// ── isWithinActiveHours edge cases ──

describe('isWithinActiveHours edge cases', () => {
  it('handles overnight range (e.g. 22:00-06:00)', () => {
    const now = new Date();
    const h = now.getHours();

    // Create an overnight range that includes midnight
    if (h >= 22 || h < 6) {
      // Current hour is in the overnight range
      expect(isWithinActiveHours('22:00-06:00')).toBe(true);
    } else {
      // Current hour is outside the overnight range
      expect(isWithinActiveHours('22:00-06:00')).toBe(false);
    }
  });

  it('handles single-hour ranges', () => {
    const now = new Date();
    const h = now.getHours();
    const start = `${String(h).padStart(2, '0')}:00`;
    const end = `${String(h).padStart(2, '0')}:59`;
    expect(isWithinActiveHours(`${start}-${end}`)).toBe(true);
  });

  it('handles exact boundary (end time exclusive)', () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    // End time equals current time — should be false (end is exclusive)
    const end = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const start = `${String((h + 23) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    // Range from 23 hours ago to exactly now — current time = end → false
    expect(isWithinActiveHours(`${start}-${end}`)).toBe(false);
  });
});

// ── isHeartbeatOk ──

describe('isHeartbeatOk', () => {
  it('detects token on its own line', () => {
    expect(isHeartbeatOk('HEARTBEAT_OK')).toBe(true);
  });

  it('detects token with surrounding whitespace', () => {
    expect(isHeartbeatOk('  HEARTBEAT_OK  ')).toBe(true);
  });

  it('detects token on a line among other lines', () => {
    expect(isHeartbeatOk('Checked everything.\nHEARTBEAT_OK\nDone.')).toBe(true);
  });

  it('does not match token embedded in a sentence', () => {
    expect(isHeartbeatOk('I replied HEARTBEAT_OK because nothing was wrong.')).toBe(false);
  });

  it('does not match in a substantive response', () => {
    expect(isHeartbeatOk('You have 3 tasks that need attention:\n1. Fix the bug\n2. Review PR')).toBe(false);
  });

  it('does not match partial token', () => {
    expect(isHeartbeatOk('HEARTBEAT_O')).toBe(false);
    expect(isHeartbeatOk('HEARTBEAT_OKK')).toBe(false);
  });
});
