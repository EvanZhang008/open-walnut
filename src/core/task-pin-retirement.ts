/**
 * Pin retirement — time-based expiry of COMPLETED pins.
 *
 * Why this exists. Two deliberate decisions meet badly:
 *   1. `task_create` puts new work on the board (`newTaskPinDefault` → pinned).
 *   2. Completing a task does NOT unpin it (2026-08-26, user request) so the
 *      board shows recently-finished work in its tier.
 * Neither is wrong, but nothing ever RETIRED an old done pin, so the pinned set
 * only ever grew. Measured on the live box 2026-08-31: 1,237 pinned tasks, 91 of
 * them open — 1,146 finished pins, the oldest completed in MARCH, including
 * auto-created probe tasks from a dogfood run a week earlier. Per tier the Focus
 * board held 703 rows for 16 real open tasks, which is what the phone reported.
 *
 * The fix is a clock, not a policy change: a pin survives completion, then
 * retires `tasks.pin_retirement_days` (default 3) after the work finished. The
 * first sweep on a long-running box IS the one-time cleanup — no migration
 * script, because "retire everything already past the window" is exactly what
 * the steady-state sweep does.
 *
 * What it never does: delete a task, touch an OPEN task, touch a pin completed
 * inside the window, or change any field other than the pin trio. A completed
 * task that still has a cron interest or a live session is unpinned like any
 * other — unpinning removes it from a board view, nothing else.
 */

import { CLOUD_MODE } from '../constants.js';
import { getConfig } from './config-manager.js';
import { bus, EventNames } from './event-bus.js';
import { log } from '../logging/index.js';
import { getPinnedTasks, updateTasksBulk } from './task-manager.js';
import type { Task } from './types.js';

/**
 * Days a finished pin stays on the board. 3 is the shortest window that still
 * covers "I finished it Friday, I want to see it Monday".
 */
export const DEFAULT_PIN_RETIREMENT_DAYS = 3;

/**
 * Rows unpinned per store write. Each chunk is ONE `updateTasksBulk`, i.e. one
 * in-process write lock + one CROSS-PROCESS file lock on the task store + one
 * SQLite transaction + one whole-store cache invalidation, and the loop yields to
 * the event loop between chunks. Small enough that no single chunk holds the task
 * write lock long enough to stall a session spawn or an HTTP route.
 *
 * Do NOT lower it: the cost is per CHUNK, not per row. Measured end to end:
 * 1,100 rows / 22 chunks = 628 ms, and 3,330 rows / 67 chunks = 461 ms. Row count
 * barely moves the number, chunk count is what buys the lock cycles, so a smaller
 * chunk size only multiplies lock acquisitions and cache rebuilds.
 */
export const PIN_RETIREMENT_CHUNK_SIZE = 50;

/** Daily re-sweep interval. */
export const PIN_RETIREMENT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Boot-pass delay. Deliberately later than the lane-orphan first pass (8s) and
 * off the 30s git-sync tick: nothing here is urgent, and the board is already
 * wrong — one more minute of a stale pin costs nothing, a boot-time store scan
 * competing with session re-attach does.
 */
export const PIN_RETIREMENT_BOOT_DELAY_MS = 20_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PinRetirementReport {
  /** Pinned rows examined. */
  scanned: number;
  /** Pinned + completed + past the window. */
  candidates: number;
  /** Rows actually unpinned (a candidate already unpinned by someone else is not counted). */
  retired: number;
  /** True when the knob is 0/negative — nothing was scanned or written. */
  disabled: boolean;
  /** True when the caller's budget ran out mid-sweep; the next tick finishes the job. */
  stoppedEarly: boolean;
  /** Resolved window, in days. */
  days: number;
  /** Completions strictly older than this retire. Null when disabled. */
  cutoff: string | null;
  /**
   * Oldest completion timestamp among completed pins that SURVIVED. Always
   * inside the window on a healthy sweep, so it is the one number that proves
   * the sweep did its job without over-reaching.
   */
  oldestKept: string | null;
}

/**
 * `tasks.pin_retirement_days` does not exist on `Config` yet: src/core/types.ts
 * is mid-edit by another change at the time of writing, and adding a field there
 * would tangle two unrelated commits. `getConfig()` spreads the parsed YAML
 * verbatim, so the key round-trips fine without a declaration — this local
 * extension is the read contract until the field can move into `Config`.
 */
export interface TaskRetentionConfigShape {
  tasks?: {
    /**
     * Days a completed pin stays on the board. 0 or negative disables retirement.
     * Typed `unknown`, not `number`: the value comes from hand-edited YAML, so a
     * quoted "3", an empty key, and an outright typo are all reachable and the
     * resolver below is the only thing allowed to interpret it.
     */
    pin_retirement_days?: unknown;
  };
}

/**
 * Resolve the knob. Only a finite number or a numeric string counts; anything
 * else (missing, blank, typo, boolean, list, map) falls back to the default. A
 * resolved value is returned as-is, so 0 and negatives reach the caller, which is
 * what turns retirement off.
 *
 * The strictness is the point. `Number(true)` is 1, so a `pin_retirement_days:
 * yes` in YAML used to silently mean "retire everything finished more than a day
 * ago" — a wildly narrower window than the default, chosen by nobody.
 */
export function resolvePinRetirementDays(config: unknown): number {
  const raw = (config as TaskRetentionConfigShape | null | undefined)
    ?.tasks?.pin_retirement_days;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : DEFAULT_PIN_RETIREMENT_DAYS;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return DEFAULT_PIN_RETIREMENT_DAYS;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : DEFAULT_PIN_RETIREMENT_DAYS;
  }
  return DEFAULT_PIN_RETIREMENT_DAYS;
}

/** Completion is either half of the phase/status pair — legacy rows can carry one without the other. */
export function isCompletedTask(task: Pick<Task, 'phase' | 'status'>): boolean {
  return task.phase === 'COMPLETE' || task.status === 'done';
}

/**
 * When the work finished, in epoch ms. `completed_at` is the real answer;
 * `updated_at` is the fallback for rows completed before that column was
 * written. Null when neither parses — a row whose age is unknowable is KEPT,
 * because "I can't tell how old this is" must never read as "it's old".
 */
export function completionTimeMs(task: Pick<Task, 'completed_at' | 'updated_at'>): number | null {
  for (const raw of [task.completed_at, task.updated_at]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * The whole decision, in one testable predicate: a pinned, completed task whose
 * completion is strictly older than the cutoff. Exactly-at-cutoff is kept (the
 * boundary belongs to the surviving side).
 */
export function isRetirablePin(
  task: Pick<Task, 'pinned' | 'phase' | 'status' | 'completed_at' | 'updated_at'>,
  cutoffMs: number,
): boolean {
  if (!task.pinned) return false;
  if (!isCompletedTask(task)) return false;
  const completedMs = completionTimeMs(task);
  if (completedMs === null) return false;
  return completedMs < cutoffMs;
}

/**
 * The unpin patch. Byte-identical in effect to `togglePin`'s unpin branch:
 * `pinned` false, `pin_order` and `focus_tier` CLEARED (`null` is the
 * explicit-clear marker the raw/bulk update path understands).
 *
 * Why focus_tier goes too, rather than being kept "for history": a tier is a
 * property of the pinned board and nothing reads it on an unpinned row
 * (`task-query.ts` only matches `focusTiers` against pinned rows). Leaving one
 * behind would be a latent bug rather than a record — `togglePin`'s PIN branch
 * never writes `focus_tier`, so a stale `focus` would silently teleport the task
 * back into the Focus tier the next time anyone re-pinned it, instead of landing
 * in Satellite like every other fresh pin. Keeping the two unpin shapes
 * identical also means the replica op path (`fields` carrying explicit clears)
 * already handles this one.
 *
 * `updated_at` is deliberately NOT bumped. Retirement is housekeeping, not a
 * user edit, and `updated_at` drives recency everywhere (`sort: updated_desc`,
 * the recent-task ledger, search decay, the projection's byte-budget fill
 * order). Bumping 1136 rows on the first boot would flood every recency surface
 * with the same 8-day-old junk this sweep exists to remove.
 */
function unpinPatch(): Partial<Task> {
  return { pinned: false, pin_order: null, focus_tier: null } as unknown as Partial<Task>;
}

/** Task keys the retirement write touches — scopes the replica-side patch. */
const RETIREMENT_FIELDS = ['pinned', 'pin_order', 'focus_tier'];

export interface SweepPinRetirementOptions {
  /** Override the config knob (tests, and a future manual "retire now" call). */
  days?: number;
  /** Clock injection for boundary tests. */
  nowMs?: number;
  /** Cooperative budget: checked between chunks. Returning true stops the sweep; the next tick resumes. */
  shouldStop?: () => boolean;
  /** Rows per store write. Defaults to PIN_RETIREMENT_CHUNK_SIZE. */
  chunkSize?: number;
}

function emptyReport(days: number): PinRetirementReport {
  return {
    scanned: 0, candidates: 0, retired: 0,
    disabled: true, stoppedEarly: false,
    days, cutoff: null, oldestKept: null,
  };
}

/**
 * Retire every completed pin older than the window. Idempotent: a second run
 * finds nothing, because the first run's rows are no longer pinned.
 *
 * PRIMARY ONLY. The replica's task rows are a projection of the primary's, so a
 * sweep there would be a second writer racing the import (and its unpins would
 * be overwritten by the next projection anyway). The server also skips wiring
 * this on a replica; the guard here makes the module safe for any future caller.
 */
export async function sweepPinRetirement(
  opts: SweepPinRetirementOptions = {},
): Promise<PinRetirementReport> {
  const days = opts.days ?? resolvePinRetirementDays(await getConfig().catch(() => null));
  if (!Number.isFinite(days) || days <= 0) return emptyReport(days);
  if (CLOUD_MODE) {
    log.task.debug('pin retirement: skipped on cloud replica (primary owns task writes)');
    return { ...emptyReport(days), disabled: false };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - days * MS_PER_DAY;
  const chunkSize = Math.max(1, opts.chunkSize ?? PIN_RETIREMENT_CHUNK_SIZE);

  // ONE whole-store read (cached), then all decisions are made in memory.
  //
  // Known race, deliberately left open: the pinned set is read ONCE, so a task
  // the user REOPENS during the sweep (measured ~0.6 s for a 1,100-row backlog)
  // is still in `doomed` and loses its pin at write time. It is not closable from
  // here — `updateTasksBulk` takes a static patch per id, not a mutation callback
  // handed the current row, so there is no hook to re-check `isRetirablePin`
  // inside the transaction that does the write. Re-reading the store per chunk
  // would only narrow the window (and cost 22+ whole-store reads, since every
  // chunk invalidates the cache), not close it. Accepted because the worst case
  // is a lost pin on a row the user is actively looking at, which is one click to
  // restore, and because reopening a task inside a sub-second daily sweep is rare.
  const pinned = await getPinnedTasks();
  const doomed: string[] = [];
  let oldestKeptMs: number | null = null;
  for (const task of pinned) {
    if (isRetirablePin(task, cutoffMs)) {
      doomed.push(task.id);
      continue;
    }
    // Survivor bookkeeping is only meaningful for finished pins — an open task
    // has no completion timestamp to be "old".
    if (!isCompletedTask(task)) continue;
    const ms = completionTimeMs(task);
    if (ms !== null && (oldestKeptMs === null || ms < oldestKeptMs)) oldestKeptMs = ms;
  }

  const report: PinRetirementReport = {
    scanned: pinned.length,
    candidates: doomed.length,
    retired: 0,
    disabled: false,
    stoppedEarly: false,
    days,
    cutoff: new Date(cutoffMs).toISOString(),
    oldestKept: oldestKeptMs === null ? null : new Date(oldestKeptMs).toISOString(),
  };

  const startedAt = Date.now();
  for (let i = 0; i < doomed.length; i += chunkSize) {
    if (opts.shouldStop?.()) { report.stoppedEarly = true; break; }
    const chunk = doomed.slice(i, i + chunkSize);
    // The EXISTING task-update path: write lock + cross-process file lock +
    // single transaction + store-cache/row-shadow invalidation. Never a raw
    // rewrite of the store file. Missing ids and no-op patches are skipped
    // inside, which is what makes a concurrent user unpin/delete harmless.
    const { changed } = await updateTasksBulk(chunk.map((id) => ({ id, patch: unpinPatch() })));
    report.retired += changed.length;
    if (changed.length === 0) continue;
    // ONE bulk event per chunk, not one per row. `task:updated` with no `task`
    // and a `taskIds` list is the codebase's established bulk shape: the browser
    // collapses it into a single debounced refetch, the search/semantic indexers
    // re-enqueue exactly these ids, the task projection re-exports (debounced,
    // which is how the phone and the cloud replica learn about it), and the
    // session-hook deriver correctly ignores it (no phase changed). Emitting
    // 1,100 per-row frames on the first boot would be a WS storm for a change
    // the UI renders as "these rows left the board".
    bus.emit(
      EventNames.TASK_UPDATED,
      { task: null, taskIds: changed.map((t) => t.id), fields: RETIREMENT_FIELDS },
      ['web-ui'],
      { source: 'pin-retirement' },
    );
    // Yield between chunks so timers/IO interleave even when the store cache is
    // warm and every await above resolves synchronously-ish.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }

  const summary = { ...report, elapsedMs: Date.now() - startedAt };
  if (report.retired > 0) log.task.info('pin retirement sweep', summary);
  else log.task.debug('pin retirement sweep: nothing to retire', summary);
  return report;
}
