import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionChangesPrewarmer } from '../../src/core/session-changes-prewarm.js';

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
});
