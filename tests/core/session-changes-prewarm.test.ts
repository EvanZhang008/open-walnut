import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SessionChangesPrewarmer,
  noteSessionChangesViewed,
  _resetSessionChangesViewsForTest,
  VIEW_WINDOW_MS,
} from '../../src/core/session-changes-prewarm.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import {
  applyPressureReading,
  _resetMemoryPressureForTest,
  _setPressureHoldMsForTest,
} from '../../src/core/memory-pressure.js';
import { log } from '../../src/logging/index.js';

const NOW = new Date('2026-08-13T12:00:00Z').getTime();

function candidate(sid: string, opts: Partial<{ host: string; lastActiveAt: string }> = {}) {
  return {
    claudeSessionId: sid,
    cwd: `/repo/${sid}`,
    host: opts.host,
    outputFile: undefined,
    lastActiveAt: opts.lastActiveAt ?? new Date(NOW - 60_000).toISOString(),
  };
}

describe('SessionChangesPrewarmer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps recent sessions and computes them STRICTLY serially, paced', async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const compute = vi.fn(async (sid: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(sid);
      await new Promise((r) => setTimeout(r, 1000)); // simulated parse
      concurrent--;
    });
    const p = new SessionChangesPrewarmer({
        isViewed: () => true,
      startupDelayMs: 10, sweepIntervalMs: 1_000_000, paceMs: 500,
      listCandidates: async () => [candidate('s1'), candidate('s2'), candidate('s3')],
      compute, hasInflight: () => false,
    });
    p.start();
    await vi.advanceTimersByTimeAsync(10);      // startup sweep fires
    await vi.advanceTimersByTimeAsync(10_000);  // enough for 3 × (1000 + 500)
    p.stop();

    expect(order).toEqual(['s1', 's2', 's3']);
    expect(maxConcurrent).toBe(1); // never parallel
  });

  it('skips sessions outside the active window and respects the sweep cap', async () => {
    const compute = vi.fn(async () => {});
    const p = new SessionChangesPrewarmer({
        isViewed: () => true,
      startupDelayMs: 10, sweepIntervalMs: 1_000_000, paceMs: 1, sweepCap: 2,
      activeWindowMs: 3_600_000, // 1h
      listCandidates: async () => [
        candidate('fresh1'),
        candidate('stale', { lastActiveAt: new Date(NOW - 2 * 3_600_000).toISOString() }),
        candidate('fresh2'),
        candidate('fresh3'), // over the cap of 2
      ],
      compute, hasInflight: () => false,
    });
    p.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(5_000);
    p.stop();

    const warmed = compute.mock.calls.map((c) => c[0]);
    expect(warmed).toEqual(['fresh1', 'fresh2']);
  });

  it('does not re-warm a session within the cooldown, and dedups queued entries', async () => {
    const compute = vi.fn(async () => {});
    const list = async () => [candidate('s1')];
    const p = new SessionChangesPrewarmer({
        isViewed: () => true,
      startupDelayMs: 10, sweepIntervalMs: 100, paceMs: 1, cooldownMs: 60_000,
      listCandidates: list, compute, hasInflight: () => false,
    });
    p.start();
    await vi.advanceTimersByTimeAsync(10);   // first sweep → warm
    await vi.advanceTimersByTimeAsync(500);  // several more sweeps inside cooldown
    p.stop();

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('skips a session whose compute is already in flight (user-triggered)', async () => {
    const compute = vi.fn(async () => {});
    const p = new SessionChangesPrewarmer({
        isViewed: () => true,
      startupDelayMs: 10, sweepIntervalMs: 1_000_000, paceMs: 1,
      listCandidates: async () => [candidate('busy'), candidate('free')],
      compute,
      hasInflight: (sid) => sid === 'busy',
    });
    p.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(5_000);
    p.stop();

    const warmed = compute.mock.calls.map((c) => c[0]);
    expect(warmed).toEqual(['free']);
  });

  it('a failing compute is logged and skipped — the drain continues', async () => {
    const order: string[] = [];
    const compute = vi.fn(async (sid: string) => {
      order.push(sid);
      if (sid === 's1') throw new Error('read failed');
    });
    const p = new SessionChangesPrewarmer({
        isViewed: () => true,
      startupDelayMs: 10, sweepIntervalMs: 1_000_000, paceMs: 1,
      listCandidates: async () => [candidate('s1'), candidate('s2')],
      compute, hasInflight: () => false,
    });
    p.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(5_000);
    p.stop();

    expect(order).toEqual(['s1', 's2']);
  });

  it('stop() halts the drain mid-queue', async () => {
    const compute = vi.fn(async () => { await new Promise((r) => setTimeout(r, 1000)); });
    const p = new SessionChangesPrewarmer({
        isViewed: () => true,
      startupDelayMs: 10, sweepIntervalMs: 1_000_000, paceMs: 500,
      listCandidates: async () => [candidate('s1'), candidate('s2'), candidate('s3')],
      compute, hasInflight: () => false,
    });
    p.start();
    await vi.advanceTimersByTimeAsync(10);     // sweep
    await vi.advanceTimersByTimeAsync(1_100);  // s1 done, pacing before s2
    p.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(compute.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('memory pressure pauses proactive warms and drops the backlog until it clears', async () => {
    vi.spyOn(log.web, 'info').mockImplementation(() => {});
    vi.spyOn(log.web, 'warn').mockImplementation(() => {});
    _resetMemoryPressureForTest();
    _setPressureHoldMsForTest(1);
    try {
      const order: string[] = [];
      const compute = vi.fn(async (sid: string) => {
        order.push(sid);
        await new Promise((r) => setTimeout(r, 1000));
      });
      const p = new SessionChangesPrewarmer({
        isViewed: () => true,
        // Sweeps far enough apart that none lands mid-compute (a sweep then
        // re-queues the session being computed, which is not what this tests).
        startupDelayMs: 10, sweepIntervalMs: 5_000, paceMs: 500,
        listCandidates: async () => [candidate('s1'), candidate('s2'), candidate('s3')],
        compute, hasInflight: () => false,
      });
      p.start();
      await vi.advanceTimersByTimeAsync(10);     // sweep: s1 computing, s2 + s3 queued
      applyPressureReading('warn');              // pressure lands mid-compute
      await vi.advanceTimersByTimeAsync(10_000); // s1 finishes; sweeps keep firing
      expect(order).toEqual(['s1']);             // nothing else started

      applyPressureReading('normal', Date.now() + 1);
      await vi.advanceTimersByTimeAsync(10_000); // the next sweep re-queues the rest
      p.stop();
      expect(order).toEqual(['s1', 's2', 's3']);
    } finally {
      _resetMemoryPressureForTest();
      vi.restoreAllMocks();
    }
  });

  it('under memory pressure a sweep does not even list the sessions', async () => {
    // Listing reads every session record and its transcript size; the drain's
    // own guard would drop what a sweep queued, but the listing cost is paid
    // by then. The sweep itself must hold off.
    vi.spyOn(log.web, 'info').mockImplementation(() => {});
    vi.spyOn(log.web, 'warn').mockImplementation(() => {});
    _resetMemoryPressureForTest();
    _setPressureHoldMsForTest(1);
    try {
      applyPressureReading('warn');
      const listCandidates = vi.fn(async () => [candidate('s1')]);
      const compute = vi.fn(async (_sessionId: string) => {});
      const p = new SessionChangesPrewarmer({
        isViewed: () => true,
        startupDelayMs: 10, sweepIntervalMs: 1_000, paceMs: 1,
        listCandidates, compute, hasInflight: () => false,
      });
      p.start();
      await vi.advanceTimersByTimeAsync(5_000); // the startup sweep and four more
      expect(listCandidates).not.toHaveBeenCalled();
      expect(compute).not.toHaveBeenCalled();

      applyPressureReading('normal', Date.now() + 1);
      await vi.advanceTimersByTimeAsync(2_000);
      p.stop();
      expect(listCandidates).toHaveBeenCalled();
      expect(compute.mock.calls[0]?.[0]).toBe('s1');
    } finally {
      _resetMemoryPressureForTest();
      vi.restoreAllMocks();
    }
  });
});

describe('SessionChangesPrewarmer warms only what someone looks at', () => {
  // 2026-11-23: warming every recent session at start reparsed whole
  // transcripts nobody opened (2 GB read, the Mac's one service at 6.5 GB).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    _resetSessionChangesViewsForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetSessionChangesViewsForTest();
  });

  it('a start with no view computes nothing, however many recent sessions there are', async () => {
    const compute = vi.fn(async () => {});
    const p = new SessionChangesPrewarmer({
      startupDelayMs: 10, sweepIntervalMs: 1_000, paceMs: 1,
      listCandidates: async () => Array.from({ length: 30 }, (_, i) => candidate(`s${i}`)),
      compute, hasInflight: () => false,
    });
    p.start();
    await vi.advanceTimersByTimeAsync(10_000); // the first sweep and nine more
    p.stop();
    expect(compute).not.toHaveBeenCalled();
  });

  it('a viewed session is kept warm, on its own host only, until its view is old', async () => {
    const compute = vi.fn(async () => {});
    noteSessionChangesViewed('seen', 'clouddev');
    noteSessionChangesViewed('local-seen');
    const p = new SessionChangesPrewarmer({
      startupDelayMs: 10, sweepIntervalMs: 60_000, paceMs: 1, cooldownMs: 1,
      listCandidates: async () => [
        candidate('seen', { host: 'clouddev' }), candidate('local-seen'),
        candidate('seen-elsewhere', { host: 'clouddev' }), candidate('never'),
      ],
      compute, hasInflight: () => false,
    });
    p.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(compute.mock.calls.map((c) => c[0]).sort()).toEqual(['local-seen', 'seen']);
    await vi.advanceTimersByTimeAsync(VIEW_WINDOW_MS);
    compute.mockClear();
    await vi.advanceTimersByTimeAsync(3 * 60_000); // three more sweeps, the views now old
    p.stop();
    expect(compute).not.toHaveBeenCalled();
  });

  it('a turn that ends warms its session only when someone viewed it', async () => {
    const compute = vi.fn(async () => {});
    const p = new SessionChangesPrewarmer({
      startupDelayMs: 1_000_000, sweepIntervalMs: 1_000_000, paceMs: 1, turnDebounceMs: 10,
      listCandidates: async () => [], compute, hasInflight: () => false,
      lookupSession: async (sid) => candidate(sid),
    });
    try {
      p.start();
      bus.emit(EventNames.SESSION_RESULT, { sessionId: 'quiet' }, ['test']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(compute).not.toHaveBeenCalled();
      noteSessionChangesViewed('watched');
      bus.emit(EventNames.SESSION_RESULT, { sessionId: 'watched' }, ['test']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(compute.mock.calls.map((c) => c[0])).toEqual(['watched']);
    } finally {
      p.stop();
    }
  });
});
