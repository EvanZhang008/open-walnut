/**
 * wake: run a routine because enough new items arrived, not because the clock
 * said so.
 *
 * Why this lives in the routines layer and not in the cron engine: the engine
 * (cron/{service,timer,ops,store}.ts) never imports the event bus — it is
 * injectable deps plus a clock, which is what makes it unit-testable without a
 * bus. The routines layer already owns "who and what" and already reaches the
 * bus (trigger-events.ts), so the subscription belongs here. The engine only
 * owns the number (`bumpWake`) and whether it crossed the threshold.
 *
 * Three rules this file exists to keep:
 *
 *  - ONE named global subscriber, never one per job. A global subscriber is
 *    consulted for every event on the hot path, so its `interest` allowlist is
 *    not optional: without it, every streaming delta would wake this handler
 *    (src/core/event-bus.ts, interest semantics). `bus.subscribe` overwrites by
 *    name, so re-arming with a new interest set is how the set stays current.
 *
 *  - Re-arm on a definition change, not on a timer. There is no bus event for a
 *    cron mutation (the engine's onEvent goes to WebSocket clients), so the
 *    server calls refreshRoutineWake() from that same hook — one call site that
 *    covers REST, the agent's cron tools and the cloud relay alike.
 *
 *  - Buffer, then flush. Ten mail accounts reporting in one tick must be ONE
 *    disk write, so counts accumulate in memory and a 5s TRAILING timer folds
 *    them into the store. (CoalescingQueue in event-bus.ts is the same idea, but
 *    its 60s normal flush is far too slow for a threshold anybody is waiting on.)
 */

import { bus, type BusEvent } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { CronJob } from '../cron/types.js';

/** The ONE subscriber name. Re-arming overwrites it; nothing else may use it. */
export const WAKE_SUBSCRIBER = 'routine-wake';
/** Trailing flush window: long enough to fold a burst, short enough to feel live. */
export const WAKE_FLUSH_MS = 5_000;
/** Re-arm debounce: a save emits several cron events in a row. */
const WAKE_REARM_MS = 100;

type WakeBump = { count: number; threshold: number; due: boolean };

/** The in-memory shape of one wake routine, so counting costs no disk read. */
type Watcher = {
  jobId: string;
  events: Set<string>;
  countField?: string;
  threshold: number;
};

export type RoutineWakeDeps = {
  /** Enabled jobs, for the interest set. Defaults to the live cron service. */
  listJobs?: () => Promise<CronJob[]>;
  bumpWake?: (jobId: string, n: number) => Promise<WakeBump | null>;
  runNow?: (jobId: string) => Promise<unknown>;
  flushMs?: number;
  rearmMs?: number;
};

export type RoutineWakeHandle = {
  stop(): void;
  /** Recompute the interest set from the store. Debounced; safe to spam. */
  refresh(): void;
  /** Diagnostics + tests: proof the interest allowlist is doing its job. */
  stats(): { handled: number; interest: string[]; watchers: number; pending: number };
};

// ── Default deps: the live server's cron service ──

async function defaultListJobs(): Promise<CronJob[]> {
  // Dynamic import for the same reason routines-core.ts uses one: the web route
  // module owns the live service instance, and importing it statically from here
  // would drag the router into every consumer of the routines layer.
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  if (!service) return [];
  return await service.list({ includeDisabled: false });
}

async function defaultBumpWake(jobId: string, n: number): Promise<WakeBump | null> {
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  if (!service) return null;
  return await service.bumpWake(jobId, n);
}

async function defaultRunNow(jobId: string): Promise<unknown> {
  const { runRoutineNow } = await import('./routines-core.js');
  return await runRoutineNow(jobId);
}

/** How much this event adds: the named numeric field, else one item. */
function countOf(event: BusEvent, countField: string | undefined): number {
  if (!countField) return 1;
  const data = event.data;
  if (!data || typeof data !== 'object') return 0;
  const raw = (data as Record<string, unknown>)[countField];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

let active: RoutineWakeHandle | null = null;

/**
 * Start the wake subscriber. Idempotent: starting again replaces the previous
 * one (its subscriber name is overwritten anyway, so leaving two alive would
 * leak a buffer that can never flush).
 */
export function startRoutineWake(deps: RoutineWakeDeps = {}): RoutineWakeHandle {
  active?.stop();

  const listJobs = deps.listJobs ?? defaultListJobs;
  const bumpWake = deps.bumpWake ?? defaultBumpWake;
  const runNow = deps.runNow ?? defaultRunNow;
  const flushMs = deps.flushMs ?? WAKE_FLUSH_MS;
  const rearmMs = deps.rearmMs ?? WAKE_REARM_MS;

  let watchers: Watcher[] = [];
  let interest: string[] = [];
  let handled = 0;
  let stopped = false;
  const pending = new Map<string, number>();
  const firing = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let rearmTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush(): void {
    if (stopped || flushTimer) return;
    flushTimer = setTimeout(() => { void flush(); }, flushMs);
  }

  async function fire(jobId: string, bump: WakeBump): Promise<void> {
    // A second flush must not start a second run. ops.run also answers
    // 'already-running' before it honours a force, so this guard is belt and
    // braces for the window between the decision and the running marker.
    if (firing.has(jobId)) return;
    firing.add(jobId);
    try {
      log.cron.info('wake threshold reached — running routine', {
        jobId, count: bump.count, threshold: bump.threshold,
      });
      await runNow(jobId);
    } catch (err) {
      log.cron.warn('wake run failed', {
        jobId, error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      firing.delete(jobId);
    }
  }

  async function flush(): Promise<void> {
    flushTimer = null;
    if (stopped || pending.size === 0) return;
    const batch = [...pending.entries()];
    pending.clear();
    for (const [jobId, n] of batch) {
      try {
        const bump = await bumpWake(jobId, n);
        // Not awaited: a run can take minutes, and the rest of this batch's
        // counters must land now rather than behind it.
        if (bump?.due) void fire(jobId, bump);
      } catch (err) {
        log.cron.warn('wake flush failed', {
          jobId, added: n, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function handler(event: BusEvent): void {
    handled += 1;
    let matched = 0;
    for (const w of watchers) {
      if (!w.events.has(event.name)) continue;
      const n = countOf(event, w.countField);
      if (n <= 0) continue;
      pending.set(w.jobId, (pending.get(w.jobId) ?? 0) + n);
      matched += 1;
    }
    if (matched > 0) scheduleFlush();
  }

  async function rearm(): Promise<void> {
    if (stopped) return;
    let jobs: CronJob[];
    try {
      jobs = await listJobs();
    } catch (err) {
      log.cron.warn('wake re-arm failed — keeping the previous interest set', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (stopped) return;
    watchers = jobs
      .filter((j) => j.enabled && j.wake && j.wake.events.length > 0)
      .map((j) => ({
        jobId: j.id,
        events: new Set(j.wake!.events),
        ...(j.wake!.countField ? { countField: j.wake!.countField } : {}),
        threshold: j.wake!.threshold,
      }));
    // A routine that was disabled or deleted must not keep a buffered count that
    // a later flush would write back onto a stranger with a recycled id.
    for (const jobId of [...pending.keys()]) {
      if (!watchers.some((w) => w.jobId === jobId)) pending.delete(jobId);
    }
    interest = [...new Set(watchers.flatMap((w) => [...w.events]))];
    if (interest.length === 0) {
      // No wake routines: cost the bus nothing at all rather than sit in its
      // subscriber map matching an empty allowlist on every event.
      bus.unsubscribe(WAKE_SUBSCRIBER);
      return;
    }
    bus.subscribe(WAKE_SUBSCRIBER, handler, { global: true, interest });
    log.cron.debug('wake subscriber armed', { watchers: watchers.length, interest });
  }

  const handle: RoutineWakeHandle = {
    stop() {
      stopped = true;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      if (rearmTimer) clearTimeout(rearmTimer);
      rearmTimer = null;
      pending.clear();
      watchers = [];
      interest = [];
      bus.unsubscribe(WAKE_SUBSCRIBER);
      if (active === handle) active = null;
    },
    refresh() {
      if (stopped || rearmTimer) return;
      rearmTimer = setTimeout(() => { rearmTimer = null; void rearm(); }, rearmMs);
    },
    stats() {
      return { handled, interest: [...interest], watchers: watchers.length, pending: pending.size };
    },
  };

  active = handle;
  handle.refresh();
  return handle;
}

/**
 * Re-arm the running subscriber after a routine definition changed. A no-op when
 * wake was never started (CLI paths, tests), so callers need no null check.
 */
export function refreshRoutineWake(): void {
  active?.refresh();
}

/** Tests only: the live handle, so a spec can read its stats without holding it. */
export function getRoutineWakeHandleForTesting(): RoutineWakeHandle | null {
  return active;
}
