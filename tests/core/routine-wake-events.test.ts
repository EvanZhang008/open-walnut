/**
 * The wake subscriber (src/core/routines/wake-events.ts) against the REAL event
 * bus, because the thing being tested is how it behaves as a global subscriber:
 *
 *  6. interest hygiene — a burst of unrelated (streaming-class) events must not
 *     invoke the handler even once. A global subscriber is consulted for every
 *     event on the hot path, so its `interest` allowlist is the whole guard.
 *  7. live re-arm — a second wake routine starts counting with no restart.
 *  8. disabled / deleted — a routine that is off counts nothing, and a deleted
 *     one leaves neither an interest entry nor a buffered count behind.
 *
 * Plus the flush contract: ten events in one window are ONE store write, and the
 * run starts only when the flushed count reaches the threshold.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { bus } from '../../src/core/event-bus.js';
import { startRoutineWake, WAKE_SUBSCRIBER, type RoutineWakeHandle } from '../../src/core/routines/wake-events.js';
import type { CronJob, CronWake } from '../../src/core/cron/types.js';

const MAIL_EVENT = 'plugin:mail:messages-received';
const SLACK_EVENT = 'plugin:slack:messages-received';

/** Emit under an arbitrary name (the typed overload wants a known payload). */
function emitRaw(name: string, data: unknown): void {
  bus.emit(name, data, ['web-ui']);
}

function wakeJob(id: string, events: string[], overrides?: Partial<CronWake> & { enabled?: boolean }): CronJob {
  const { enabled = true, ...wake } = overrides ?? {};
  return {
    id,
    name: `routine ${id}`,
    enabled,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: 'every', everyMs: 1_800_000, anchorMs: 0 },
    sessionTarget: 'isolated',
    wakeMode: 'next-cycle',
    payload: { kind: 'agentTurn', message: 'go' },
    executor: { type: 'claude-code', config: { instructions: 'go' } },
    wake: { events, threshold: 3, ...wake },
    state: {},
  } as CronJob;
}

type Harness = {
  handle: RoutineWakeHandle;
  jobs: CronJob[];
  counters: Map<string, number>;
  bump: ReturnType<typeof vi.fn>;
  runNow: ReturnType<typeof vi.fn>;
  /** Re-arm and wait for the interest set to settle. */
  refresh: (expectWatchers: number) => Promise<void>;
};

let harness: Harness | null = null;

function start(jobs: CronJob[]): Harness {
  const counters = new Map<string, number>();
  // Stands in for CronService.bumpWake: the same contract (count after the bump,
  // the job's threshold, and whether that crossed it).
  const bump = vi.fn(async (jobId: string, n: number) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job?.wake || !job.enabled) return null;
    const count = (counters.get(jobId) ?? 0) + n;
    counters.set(jobId, count);
    const threshold = job.wake.threshold;
    return { count, threshold, due: threshold > 0 && count >= threshold };
  });
  const runNow = vi.fn(async (jobId: string) => {
    counters.set(jobId, 0);
    return { result: { ok: true } };
  });
  const handle = startRoutineWake({
    listJobs: async () => jobs,
    bumpWake: bump,
    runNow,
    flushMs: 20,
    rearmMs: 1,
  });
  const h: Harness = {
    handle, jobs, counters, bump, runNow,
    refresh: async (expectWatchers: number) => {
      handle.refresh();
      await vi.waitFor(() => expect(handle.stats().watchers).toBe(expectWatchers));
    },
  };
  harness = h;
  return h;
}

beforeEach(() => {
  bus.unsubscribe(WAKE_SUBSCRIBER);
});

afterEach(() => {
  harness?.handle.stop();
  harness = null;
  bus.unsubscribe(WAKE_SUBSCRIBER);
});

describe('routine wake subscriber', () => {
  it('is never invoked by unrelated events: 1000 streaming-class emits, zero handler calls', async () => {
    const h = start([wakeJob('mail-1', [MAIL_EVENT])]);
    await h.refresh(1);
    expect(h.handle.stats().interest).toEqual([MAIL_EVENT]);

    for (let i = 0; i < 1_000; i++) {
      emitRaw('session:text-delta', { sessionId: 's1', text: 'x' });
      emitRaw('session:tool-use', { sessionId: 's1', toolUseId: `t${i}` });
    }
    expect(h.handle.stats().handled).toBe(0);
    expect(h.bump).not.toHaveBeenCalled();

    // The matching event proves the subscriber is alive, not merely filtered out.
    emitRaw(MAIL_EVENT, { count: 1 });
    expect(h.handle.stats().handled).toBe(1);
  });

  it('stays ONE subscriber across re-arms: a single emit invokes the handler once', async () => {
    const h = start([wakeJob('mail-1', [MAIL_EVENT])]);
    await h.refresh(1);
    await h.refresh(1);
    await h.refresh(1);

    emitRaw(MAIL_EVENT, { count: 1 });
    expect(h.handle.stats().handled).toBe(1);
  });

  it('re-arms live: a second wake routine starts counting with no restart', async () => {
    const h = start([wakeJob('mail-1', [MAIL_EVENT])]);
    await h.refresh(1);

    emitRaw(SLACK_EVENT, { count: 5 });
    expect(h.handle.stats().handled).toBe(0);

    h.jobs.push(wakeJob('slack-1', [SLACK_EVENT]));
    await h.refresh(2);
    expect(h.handle.stats().interest.sort()).toEqual([MAIL_EVENT, SLACK_EVENT].sort());

    emitRaw(SLACK_EVENT, { count: 5 });
    await vi.waitFor(() => expect(h.bump).toHaveBeenCalledWith('slack-1', 1));
  });

  it('counts nothing for a disabled routine, and nothing at all once it is deleted', async () => {
    const job = wakeJob('mail-1', [MAIL_EVENT]);
    const h = start([job]);
    await h.refresh(1);

    job.enabled = false;
    await h.refresh(0);
    // No wake routine left: the subscriber steps off the bus entirely rather than
    // matching an empty allowlist on every event.
    emitRaw(MAIL_EVENT, { count: 9 });
    expect(h.handle.stats().handled).toBe(0);

    job.enabled = true;
    await h.refresh(1);
    emitRaw(MAIL_EVENT, { count: 1 });
    await vi.waitFor(() => expect(h.bump).toHaveBeenCalledTimes(1));

    // Deleting drops the buffered count too: a recycled id must not inherit a
    // stranger's batch.
    emitRaw(MAIL_EVENT, { count: 1 });
    h.jobs.length = 0;
    await h.refresh(0);
    expect(h.handle.stats().pending).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.bump).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst into ONE store write, summing what each event carried', async () => {
    const h = start([wakeJob('mail-1', [MAIL_EVENT], { countField: 'count', threshold: 20 })]);
    await h.refresh(1);

    emitRaw(MAIL_EVENT, { count: 7 });
    emitRaw(MAIL_EVENT, { count: 7 });
    emitRaw(MAIL_EVENT, { count: 8 });
    await vi.waitFor(() => expect(h.bump).toHaveBeenCalledTimes(1));
    expect(h.bump).toHaveBeenCalledWith('mail-1', 22);
    // Crossing the threshold is what starts the run, and it starts exactly once.
    await vi.waitFor(() => expect(h.runNow).toHaveBeenCalledTimes(1));
    expect(h.runNow).toHaveBeenCalledWith('mail-1');
  });

  it('adds one per event without a countField, and ignores a non-numeric payload field', async () => {
    const h = start([
      wakeJob('plain', [MAIL_EVENT], { threshold: 0 }),
      wakeJob('counted', [MAIL_EVENT], { countField: 'count', threshold: 0 }),
    ]);
    await h.refresh(2);

    emitRaw(MAIL_EVENT, { count: 4 });
    emitRaw(MAIL_EVENT, { count: 'lots' });
    emitRaw(MAIL_EVENT, null);
    await vi.waitFor(() => expect(h.bump).toHaveBeenCalledTimes(2));
    // Three events, so +3 for the plain watcher; only the first carried a usable
    // number, so +4 for the counted one.
    expect(h.bump).toHaveBeenCalledWith('plain', 3);
    expect(h.bump).toHaveBeenCalledWith('counted', 4);
    // threshold 0 means clock-only: counting still happens, no run is started.
    expect(h.runNow).not.toHaveBeenCalled();
  });

  it('stops cleanly: after stop() the bus no longer reaches it', async () => {
    const h = start([wakeJob('mail-1', [MAIL_EVENT])]);
    await h.refresh(1);
    h.handle.stop();

    emitRaw(MAIL_EVENT, { count: 5 });
    expect(h.handle.stats().handled).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.bump).not.toHaveBeenCalled();
  });
});
