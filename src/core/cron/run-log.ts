/**
 * A clock routine's run history, and the runs it should have made and did not.
 *
 * 2026-11-08: the daily org reflection (08:00 Pacific) made no task. Its run had started and
 * failed 48 s later (the Mac had no room to start a session), and the error backoff put the next
 * run on the next day's slot. Nothing kept that run: `state` holds only the last one, which the
 * next morning's run replaced, and the error text was in no log. Now every run of a routine
 * without a check leaves a row here, newest first, a slot that ended with no good run is a missed
 * run (shown on the Routines page and told to the routine's owner), and a catch-up run names the
 * slot it stands for.
 *
 * Pure, so the rules are pinned by unit tests; the timer appends inside its locked persist.
 */

import type { CronJob, RoutineRunEntry } from './types.js';
import { scheduleNextRunAtMs } from './jobs.js';

/**
 * Rows kept per routine: a month of a daily routine. Slots older than the oldest kept row are not
 * judged (a trimmed row is not a run that never happened).
 */
export const RUN_LOG_MAX = 30;
/** How much of a run's summary or error a row keeps. */
export const RUN_TEXT_CAP = 300;
/** A slot is judged only this long after it came due: a run that is still starting is not missed. */
export const MISSED_GRACE_MS = 15 * 60_000;
/** How far back missed runs are looked for. */
export const MISSED_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** Routines more frequent than this are not judged slot by slot: one run covers many of their slots. */
export const MISSED_MIN_INTERVAL_MS = 60 * 60_000;
/** At most this many missed runs are reported per routine. */
export const MISSED_MAX = 5;
/**
 * A start that failed because something broke (no room on the host, a throw) is tried again
 * inside its own slot this many times, after the error backoff, before the slot is given up.
 */
export const SLOT_RETRIES = 3;

function clip(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > RUN_TEXT_CAP ? `${flat.slice(0, RUN_TEXT_CAP - 1)}…` : flat;
}

/** A run that did not do its work: an error, or a skip that says why it could not run. */
export function runFailed(entry: Pick<RoutineRunEntry, 'status' | 'error'>): boolean {
  return entry.status === 'error' || (entry.status === 'skipped' && !!entry.error);
}

export function runEntry(r: {
  atMs: number;
  durationMs: number;
  status: RoutineRunEntry['status'];
  slotMs?: number;
  error?: string;
  summary?: string;
  sessionId?: string;
  manual?: boolean;
  catchUpMs?: number;
  attempt?: number;
  willRetryAtMs?: number;
  /** Other slots this one run stood for (a host's clock delivering several at once). */
  alsoSlotsMs?: number[];
}): RoutineRunEntry {
  const also = (r.alsoSlotsMs ?? []).filter((s) => Number.isFinite(s) && s !== r.slotMs);
  const error = clip(r.error);
  const summary = clip(r.summary);
  return {
    atMs: r.atMs,
    status: r.status,
    durationMs: Math.max(0, Math.round(r.durationMs)),
    ...(typeof r.slotMs === 'number' ? { slotMs: r.slotMs } : {}),
    ...(error ? { error } : {}),
    ...(summary && summary !== error ? { summary } : {}),
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.manual ? { manual: true as const } : {}),
    ...(typeof r.catchUpMs === 'number' ? { catchUpMs: r.catchUpMs } : {}),
    ...(r.attempt && r.attempt > 1 ? { attempt: r.attempt } : {}),
    ...(typeof r.willRetryAtMs === 'number' ? { willRetryAtMs: r.willRetryAtMs } : {}),
    ...(also.length ? { alsoSlotsMs: [...new Set(also)].slice(0, 50) } : {}),
  };
}

/**
 * Newest first, bounded, never mutating the input. A skip that repeats the one before it (an idle
 * triage every five minutes) adds to that row's count instead of pushing real runs out, but only
 * for the very next slot (`nextSlot`): a merged row stands for every slot from its first to its
 * last, so merging over a slot nothing ran for would hide that slot.
 */
export function appendRun(
  list: RoutineRunEntry[] | undefined,
  entry: RoutineRunEntry,
  nextSlot?: (slotMs: number) => number | undefined,
): RoutineRunEntry[] {
  const base = Array.isArray(list) ? list : [];
  const head = base[0];
  const adjacent = head?.slotMs === undefined && entry.slotMs === undefined
    || (head?.slotMs !== undefined && entry.slotMs !== undefined && nextSlot?.(head.slotMs) === entry.slotMs);
  if (head && adjacent && !head.alsoSlotsMs && !entry.alsoSlotsMs && entry.status === 'skipped' && head.status === 'skipped'
    && (head.error ?? '') === (entry.error ?? '') && (head.summary ?? '') === (entry.summary ?? '')) {
    const firstSlotMs = head.firstSlotMs ?? head.slotMs;
    return [{
      ...entry, repeats: (head.repeats ?? 1) + 1, firstAtMs: head.firstAtMs ?? head.atMs,
      ...(firstSlotMs !== undefined ? { firstSlotMs } : {}),
    }, ...base.slice(1)];
  }
  return [entry, ...base].slice(0, RUN_LOG_MAX);
}

/** A slot the routine should have run and has no good run for. */
export interface MissedRun {
  slotMs: number;
  /** Why: the failed run's error, or that no run was recorded at all. */
  reason: string;
  /** The failed run's row time, absent when nothing ran. */
  failedAtMs?: number;
}

export const NO_RUN_REASON = 'no run was recorded for this time (Walnut was not running then, or the run never started)';

/** The slots of `job` in [fromMs, toMs], oldest first, at most `max`. */
export function slotsBetween(job: CronJob, fromMs: number, toMs: number, max = 64): number[] {
  const out: number[] = [];
  let at = fromMs;
  while (out.length < max) {
    const s = scheduleNextRunAtMs(job, at);
    if (s === undefined || s > toMs) break;
    out.push(s);
    at = s + 1;
  }
  return out;
}

/** The typical gap between two slots, or undefined for a one-shot. */
function intervalMs(job: CronJob, aroundMs: number): number | undefined {
  if (job.schedule.kind === 'every') return job.schedule.everyMs;
  if (job.schedule.kind !== 'cron') return undefined;
  const [a, b] = slotsBetween(job, aroundMs, Number.MAX_SAFE_INTEGER, 2);
  return a !== undefined && b !== undefined ? b - a : undefined;
}

/** Whether `job` is judged slot by slot at all: a recurring clock routine, on, not too frequent. */
export function judgesSlots(job: CronJob, nowMs: number): boolean {
  if (!job.enabled || job.check || job.schedule.kind === 'at') return false;
  const gap = intervalMs(job, nowMs - MISSED_LOOKBACK_MS);
  return gap !== undefined && gap >= MISSED_MIN_INTERVAL_MS;
}

/**
 * The runs this routine missed, newest first. A slot counts from when the routine was last
 * started over (made, resumed, its schedule edited) and when its history began, so a slot it was
 * paused through, or one from before this Walnut kept a history, is never called missed. A slot
 * is covered by a good run made for it (its own run, a retry, a catch-up naming it) or by any
 * good run made between it and the next slot; a person may set one aside (Dismiss).
 */
export function missedRuns(job: CronJob, nowMs: number): MissedRun[] {
  if (!judgesSlots(job, nowMs)) return [];
  const log = job.state.runLog ?? [];
  // `expectFromMs` is stamped at create and at every start over; a routine older than it has its creation.
  // A full history has dropped its oldest rows: slots before the oldest kept row are not judged.
  const oldest = log.length >= RUN_LOG_MAX ? log[log.length - 1] : undefined;
  const keptFrom = oldest ? Math.min(...[oldest.atMs, oldest.slotMs, oldest.firstSlotMs, ...(oldest.alsoSlotsMs ?? [])].filter((v): v is number => typeof v === 'number')) : 0;
  const since = Math.max(
    job.state.expectFromMs ?? job.createdAtMs,
    job.state.runLogSinceMs ?? nowMs,
    nowMs - MISSED_LOOKBACK_MS,
    keptFrom,
  );
  // Every slot of the window (hourly for a week is 168), so the newest are never cut off.
  const slots = slotsBetween(job, since, nowMs - MISSED_GRACE_MS, 1_000);
  if (!slots.length) return [];
  const dismissed = new Set(job.state.missedDismissedMs ?? []);
  const out: MissedRun[] = [];
  for (let i = slots.length - 1; i >= 0 && out.length < MISSED_MAX; i--) {
    const slot = slots[i];
    if (dismissed.has(slot)) continue;
    const end = slots[i + 1] ?? scheduleNextRunAtMs(job, slot + 1) ?? Number.MAX_SAFE_INTEGER;
    // A recorded slot covers the slot whose window [slot, end) it falls in, on the grid or not: a
    // next run an older build drifted off the grid, or an error backoff's run, is still that
    // slot's run (2026-11-10: Inbox Triage's first run after a deploy, 6.7 min off its hourly
    // grid, read as a missed run).
    const inWindow = (t: number) => t >= slot && t < end;
    const forSlot = (e: RoutineRunEntry) => e.catchUpMs === slot
      || (e.slotMs !== undefined && (e.firstSlotMs !== undefined
        // Skips in a row are one row, standing for every slot from its first to its last.
        ? e.firstSlotMs < end && e.slotMs >= slot
        : inWindow(e.slotMs)))
      || !!e.alsoSlotsMs?.some(inWindow)
      || (e.slotMs === undefined && e.catchUpMs === undefined && inWindow(e.atMs));
    const rows = log.filter(forSlot);
    if (rows.some((e) => !runFailed(e))) continue;
    // A retry still to come inside the slot: not missed yet.
    if (job.state.retrySlotMs === slot || rows.some((e) => typeof e.willRetryAtMs === 'number' && e.willRetryAtMs > nowMs)) continue;
    const failed = rows.find(runFailed);
    out.push(failed
      ? { slotMs: slot, reason: failed.error ?? 'the run failed', failedAtMs: failed.atMs }
      : { slotMs: slot, reason: NO_RUN_REASON });
  }
  return out;
}

/** The task told about this routine's missed runs: its owner, else the task a session routine runs in. */
export function routineOwnerTaskId(job: CronJob): string | undefined {
  if (job.ownerTaskId) return job.ownerTaskId;
  const cfg = job.executor?.config as { target?: unknown } | undefined;
  if (job.executor?.type === 'session' && typeof cfg?.target === 'string' && cfg.target.trim()) return cfg.target.trim();
  return undefined;
}

/** What a catch-up run's executor reads first: which run it stands for, and that it is late. */
export function catchUpNote(slotMs: number, nowMs: number): string {
  return `Walnut: this is a catch-up run of this routine. It stands for the run due at ${new Date(slotMs).toISOString()}, which did not happen; `
    + `it runs late, at ${new Date(nowMs).toISOString()}. Do the work that run would have done, for that date and time (read "today", "last night" and the like from then).`;
}
