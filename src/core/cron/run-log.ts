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
 * 2026-11-12: two more ways a slot was lost. Inbox Triage's 16:20 run waited for a free slot on a
 * full Mac, and every run after it declined with "the previous run has not started yet"; a skip
 * covered its slot, so those slots were neither run nor missed. And a routine whose slot came due
 * while the Walnut server was down was reported missed, although the boot ran it late. Now one
 * rule (runSlots) says which slots a scheduled run stands for: its own, every slot that came due
 * since, and every slot still owed by runs held behind one that had not started. A slot a coming
 * run stands for is never called missed.
 *
 * Pure, so the rules are pinned by unit tests; the timer appends inside its locked persist.
 */

import type { CronJob, RoutineRunEntry } from './types.js';
import { clockOnDaemon, scheduleNextRunAtMs } from './jobs.js';

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
/** A run held behind an earlier one that has not started looks again this soon (or at its next slot). */
export const HELD_RECHECK_MS = 10 * 60_000;

function clip(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > RUN_TEXT_CAP ? `${flat.slice(0, RUN_TEXT_CAP - 1)}…` : flat;
}

/** A run that did not do its work: an error, or a skip that says why it could not run. */
export function runFailed(entry: Pick<RoutineRunEntry, 'status' | 'error'>): boolean {
  return entry.status === 'error' || (entry.status === 'skipped' && !!entry.error);
}

/** A run that settled its slots: it did its work, or had nothing to do. A held run settled nothing. */
export function runCovers(entry: Pick<RoutineRunEntry, 'status' | 'error' | 'heldBy'>): boolean {
  return !runFailed(entry) && !entry.heldBy;
}

export function runEntry(r: {
  atMs: number;
  durationMs: number;
  status: RoutineRunEntry['status'];
  slotMs?: number;
  /** The oldest slot this run stood for, when it stood for every slot from it to `slotMs`. */
  firstSlotMs?: number;
  heldBy?: string;
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
    ...(typeof r.slotMs === 'number' && typeof r.firstSlotMs === 'number' && r.firstSlotMs < r.slotMs ? { firstSlotMs: r.firstSlotMs } : {}),
    ...(r.heldBy ? { heldBy: r.heldBy } : {}),
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
 * last, so merging over a slot nothing ran for would hide that slot. A held run looking again
 * inside the same slot repeats its row too.
 */
export function appendRun(
  list: RoutineRunEntry[] | undefined,
  entry: RoutineRunEntry,
  nextSlot?: (slotMs: number) => number | undefined,
): RoutineRunEntry[] {
  const base = Array.isArray(list) ? list : [];
  const head = base[0];
  const adjacent = head?.slotMs === undefined && entry.slotMs === undefined
    || (head?.slotMs !== undefined && entry.slotMs !== undefined
      && (head.slotMs === entry.slotMs || nextSlot?.(head.slotMs) === entry.slotMs));
  if (head && adjacent && !head.alsoSlotsMs && !entry.alsoSlotsMs && entry.status === 'skipped' && head.status === 'skipped'
    && (head.error ?? '') === (entry.error ?? '') && (head.summary ?? '') === (entry.summary ?? '')
    && (head.heldBy ?? '') === (entry.heldBy ?? '')) {
    const firsts = [head.firstSlotMs ?? head.slotMs, entry.firstSlotMs ?? entry.slotMs].filter((v): v is number => typeof v === 'number');
    const firstSlotMs = firsts.length ? Math.min(...firsts) : undefined;
    const merged: RoutineRunEntry = { ...entry, repeats: (head.repeats ?? 1) + 1, firstAtMs: head.firstAtMs ?? head.atMs };
    if (firstSlotMs !== undefined && entry.slotMs !== undefined && firstSlotMs < entry.slotMs) merged.firstSlotMs = firstSlotMs;
    else delete merged.firstSlotMs;
    return [merged, ...base.slice(1)];
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

/** The slots one scheduled run stands for (runSlots). */
export interface RunSlots {
  /** The newest: the row's `slotMs`. */
  slotMs: number;
  /** The oldest, when the run stands for every slot from it to `slotMs`. */
  firstSlotMs?: number;
  /** The run is a catch-up: it stands for more than one slot, or runs past its slot's grace. */
  late?: true;
}

/**
 * The slots a scheduled run stands for. THE rule for every entry that runs a due slot (the
 * timer's tick, the boot catch-up, a due Run): the slot it came due for, every slot that came due
 * since (the server was down, the timer could not tick), and every slot still owed (runs held
 * behind one that had not started, a failed start tried again). One run stands for all of them,
 * so they are caught up once, never skipped and never called missed. A slot a person set aside
 * (Dismiss) is never run for.
 *
 * undefined: the run stands for no slot (a trigger, no next run). null: every slot it would
 * stand for was set aside, so there is nothing to run. Frequent clocks merge downtime too;
 * judgesSlots limits missed-run notices, not which due slots a catch-up covers.
 * A one-shot still stands for its next run only.
 */
export function runSlots(job: CronJob, nowMs: number): RunSlots | null | undefined {
  if (job.check) return undefined;
  const base = job.state.retrySlotMs ?? job.state.nextRunAtMs;
  if (typeof base !== 'number' || !Number.isFinite(base)) return undefined;
  if (!job.enabled || job.schedule.kind === 'at') return { slotMs: base };
  const owed = job.state.owedFromMs;
  const from = Math.max(typeof owed === 'number' ? Math.min(owed, base) : base, nowMs - MISSED_LOOKBACK_MS);
  const dismissed = new Set(job.state.missedDismissedMs ?? []);
  const due = slotsBetween(job, from, nowMs, 1_000);
  // A frequent every-clock may have many more than 1,000 sleep slots. Its
  // newest slot is arithmetic, so one catch-up covers the whole range without
  // walking thousands of entries or leaving another backlog at the next tick.
  if (job.schedule.kind === 'every' && nowMs >= base && job.schedule.everyMs > 0) {
    const gap = job.schedule.everyMs;
    let last = base + Math.floor((nowMs - base) / gap) * gap;
    while (last > base && dismissed.has(last)) last -= gap;
    due.push(last);
  }
  const slots = [...new Set([base, ...due])]
    .filter((s) => !dismissed.has(s))
    .sort((a, b) => a - b);
  if (!slots.length) return null;
  const slotMs = slots[slots.length - 1];
  const firstSlotMs = slots[0] < slotMs ? slots[0] : undefined;
  const late = firstSlotMs !== undefined || nowMs - slotMs > MISSED_GRACE_MS;
  return { slotMs, ...(firstSlotMs !== undefined ? { firstSlotMs } : {}), ...(late ? { late: true as const } : {}) };
}

/**
 * From this slot on, a run still to come stands for every slot (runSlots): the oldest owed slot,
 * a slot being tried again, or a next run the server's timer has not made yet (it was down, or
 * the run is going now). Undefined for a clock a host's daemon holds: its next run is a report.
 */
function pendingFromMs(job: CronJob): number | undefined {
  if (clockOnDaemon(job)) return undefined;
  const s = job.state;
  const at = [s.owedFromMs, s.retrySlotMs, s.nextRunAtMs].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return at.length ? Math.min(...at) : undefined;
}

/**
 * The runs this routine missed, newest first. A slot counts from when the routine was last
 * started over (made, resumed, its schedule edited) and when its history began, so a slot it was
 * paused through, or one from before this Walnut kept a history, is never called missed. A slot
 * is covered by a good run made for it (its own run, a retry, a catch-up naming it) or by any
 * good run made between it and the next slot; a person may set one aside (Dismiss). A slot a
 * run still to come stands for (pendingFromMs) is not missed: that run catches it up.
 */
export function missedRuns(job: CronJob, nowMs: number): MissedRun[] {
  if (!judgesSlots(job, nowMs)) return [];
  const pendingFrom = pendingFromMs(job);
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
    if (pendingFrom !== undefined && slot >= pendingFrom) continue;
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
    if (rows.some(runCovers)) continue;
    // A retry still to come inside the slot: not missed yet.
    if (rows.some((e) => typeof e.willRetryAtMs === 'number' && e.willRetryAtMs > nowMs)) continue;
    const failed = rows.find(runFailed);
    const held = rows.find((e) => e.heldBy);
    out.push(failed
      ? { slotMs: slot, reason: failed.error ?? 'the run failed', failedAtMs: failed.atMs }
      : held
        ? { slotMs: slot, reason: `it waited for an earlier run (task ${held.heldBy}) that had not started, and no run came for it after`, failedAtMs: held.atMs }
        : { slotMs: slot, reason: NO_RUN_REASON });
  }
  return out;
}

/**
 * The tasks that may be told about this routine's missed runs, in order: its owner (the task whose
 * session made it), the task it delivers into now (a session routine, a trigger on a task, a router
 * wake: its executor's `target`), the org's Main. The sweep tells the first one it can reach. Only
 * a routine with none of them goes on the user's notifications (2026-11-10, Walnut VP: the org
 * reflection's and Inbox Triage's missed runs reached the user). The defaults are read from the
 * routine as it is at the sweep, never stored, so a target repaired or edited later counts.
 */
export function routineOwnerChain(job: Pick<CronJob, 'ownerTaskId' | 'executor'>, mainTaskId?: string): string[] {
  const cfg = job.executor?.config as { target?: unknown } | undefined;
  const target = typeof cfg?.target === 'string' ? cfg.target.trim() : '';
  return [...new Set([job.ownerTaskId?.trim(), target, mainTaskId?.trim()].filter((t): t is string => !!t))];
}

/** The first task of routineOwnerChain. */
export function routineOwnerTaskId(job: Pick<CronJob, 'ownerTaskId' | 'executor'>, mainTaskId?: string): string | undefined {
  return routineOwnerChain(job, mainTaskId)[0];
}

/**
 * What a catch-up run's executor reads first: which run it stands for, and that it is late.
 * `lastSlotMs`: it stands for every run due from `slotMs` to that one, merged into this one run.
 */
export function catchUpNote(slotMs: number, nowMs: number, lastSlotMs?: number): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  if (lastSlotMs !== undefined && lastSlotMs > slotMs) {
    return `Walnut: this is a catch-up run of this routine. It stands for every run due from ${iso(slotMs)} to ${iso(lastSlotMs)}, which did not happen `
      + `(Walnut was not running, or an earlier run had not started); it runs once for all of them, late, at ${iso(nowMs)}. `
      + `Do the work those runs would have done, for the whole time since ${iso(slotMs)} (read "today", "last night" and the like from then).`;
  }
  return `Walnut: this is a catch-up run of this routine. It stands for the run due at ${iso(slotMs)}, which did not happen; `
    + `it runs late, at ${iso(nowMs)}. Do the work that run would have done, for that date and time (read "today", "last night" and the like from then).`;
}
