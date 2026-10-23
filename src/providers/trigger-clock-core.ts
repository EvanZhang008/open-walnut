/**
 * Clock routines in a host daemon's trigger table (`clock-routine-v1`,
 * docs/plan/walnut-trigger.md "Clock routines"): a routine whose work runs on
 * this host keeps its clock here, so it fires while the Mac sleeps. A clock def
 * has no check; its schedule is the fire condition. Every fire goes the way a
 * trigger's does (pendingFires, claims, host delivery, acks).
 *
 * Handover, the one rule that keeps a run from happening twice: the server
 * stops ticking a routine BEFORE it pushes the def, and takes it back only from
 * the daemon's own report that it disarmed it. `fromMs` is the first slot the
 * daemon owns. The server mints a new one each time it starts the clock over (a
 * handover, a schedule edit, a resume); the same value means "keep your own
 * place", which is what lets a daemon restart catch up once on a slot it missed.
 *
 * Pure, and importing only the schedule core: the standalone twin imports it, the
 * source twin gets it through the trigger-check-core.cjs sidecar. The next slot
 * itself comes from each twin's own copy of clock-schedule-core.ts (imported by
 * the standalone, inlined by toString into the source twin).
 */

import { createClockSchedule, type ClockScheduleSpec } from './clock-schedule-core.js';
import type { PendingFire } from './trigger-check-core.js';

export const CLOCK_ROUTINE_CAPABILITY = 'clock-routine-v1';

const schedules = createClockSchedule();

/** The clock half of a def. A cron names its zone and an `every` its anchor: a host never guesses either. */
export interface TriggerClockSpec {
  schedule: ClockScheduleSpec;
  fromMs: number;
}

/** What the state file keeps of a clock: the handover it runs under and its next slot (none: an `at` that ran). */
export interface ClockHostState {
  fromMs: number;
  nextRunAtMs?: number;
}

/** A clock def this daemon disarmed or holds, in the configure reply: the server takes the clock back from it. */
export interface ClockReport {
  id: string;
  fromMs: number;
  nextRunAtMs?: number;
  /**
   * Released only: the oldest slot of a run this daemon had queued but nobody had
   * taken yet. The daemon drops that run and the server runs it instead.
   */
  owedSlotMs?: number;
}

export function validateClockSpec(raw: unknown): { ok: true; spec: TriggerClockSpec } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'clock must be an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.fromMs !== 'number' || !Number.isFinite(r.fromMs)) return { ok: false, error: 'clock.fromMs must be a number' };
  const s = r.schedule as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') return { ok: false, error: 'clock.schedule is required' };
  if (s.kind === 'cron' && (typeof s.tz !== 'string' || !s.tz.trim())) return { ok: false, error: 'clock.schedule.tz is required for a cron schedule' };
  if (s.kind === 'every' && typeof s.anchorMs !== 'number') return { ok: false, error: 'clock.schedule.anchorMs is required for an every schedule' };
  if (!schedules.supports(s)) return { ok: false, error: 'clock.schedule is not a schedule this daemon can run' };
  const schedule: ClockScheduleSpec = s.kind === 'at'
    ? { kind: 'at', at: String(s.at) }
    : s.kind === 'every'
      ? { kind: 'every', everyMs: Math.floor(s.everyMs as number), anchorMs: Math.floor(s.anchorMs as number) }
      : { kind: 'cron', expr: String(s.expr), tz: String(s.tz).trim() };
  return { ok: true, spec: { schedule, fromMs: Math.floor(r.fromMs) } };
}

/** The stable text of a clock for the set's hash. */
export function clockSpecKey(spec: TriggerClockSpec): string {
  return JSON.stringify([spec.schedule.kind, spec.schedule, spec.fromMs]);
}

/** The clock to run when a def is armed: the one on file under the same handover, else a fresh start at `fromMs`. */
export function clockStateOnArm(spec: TriggerClockSpec, prev: ClockHostState | undefined): ClockHostState {
  if (prev && prev.fromMs === spec.fromMs) return prev;
  return { fromMs: spec.fromMs, nextRunAtMs: spec.fromMs };
}

/** A run nobody has taken: no server claimed it and the host did not deliver it. */
function owed(f: PendingFire): boolean {
  return !!f.clock && !f.host && f.claimedAt === undefined;
}

/**
 * The daemon gives a clock back (configure's `released`): every run it queued
 * that nobody took goes with it, and the oldest slot among them is reported so
 * the server runs it once. A run the host is delivering right now (`inFlight`)
 * stays: its outcome is recorded here. Returns that slot, or undefined.
 */
export function releaseClockFires(
  state: { pendingFires: PendingFire[] },
  inFlight: ReadonlySet<number> = new Set(),
): number | undefined {
  let oldest: number | undefined;
  state.pendingFires = state.pendingFires.filter((f) => {
    if (!owed(f) || inFlight.has(f.seq)) return true;
    const slot = f.clock!.slotMs;
    oldest = oldest === undefined ? slot : Math.min(oldest, slot);
    return false;
  });
  return oldest;
}

/**
 * A clock armed under a new handover drops the runs nobody took under an older
 * one: the server started the clock over (an edit, a resume) or accounted for
 * them when it took the clock back. Returns whether anything was dropped.
 */
export function dropStaleClockFires(state: { pendingFires: PendingFire[] }, fromMs: number): boolean {
  const before = state.pendingFires.length;
  state.pendingFires = state.pendingFires.filter((f) => !owed(f) || f.clock!.fromMs === fromMs);
  return state.pendingFires.length !== before;
}

/**
 * When the daemon should look at it next. A slot already past (a catch-up after a
 * restart or a handover) waits `delayMs`, as a check does, so a reconnect's
 * burst never fires everything in the same breath.
 */
export function clockDueMs(clock: ClockHostState, nowMs: number, delayMs: number): number {
  if (clock.nextRunAtMs === undefined) return Number.POSITIVE_INFINITY;
  return clock.nextRunAtMs < nowMs + delayMs ? nowMs + delayMs : clock.nextRunAtMs;
}

/**
 * A fire nobody has taken yet (no server claimed it, the host did not deliver it).
 * While one is owed, a later slot adds no second fire: the owed one stands for
 * every slot it waited through, the server timer's own catch-up rule (one run for
 * however many were missed).
 */
export function clockFireOwed(pendingFires: readonly PendingFire[]): boolean {
  return pendingFires.some(owed);
}
