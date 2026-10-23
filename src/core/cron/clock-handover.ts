/**
 * Handing a routine's clock to a host's daemon and taking it back
 * (clock-routine-v1, docs/plan/walnut-trigger.md "Clock routines").
 *
 * A routine whose work runs on a host keeps its clock in that host's daemon, so
 * it fires while the Mac sleeps. Which routines qualify is the routines layer's
 * call (routines/clock-placement.ts); this file owns the one rule that keeps a run
 * from happening twice, and it writes under the same lock the timer takes:
 *
 *  - the server stops ticking a routine (sets `state.clockHost`) BEFORE the push
 *    that hands it over, under the lock that also marks a due job running, so a
 *    run the timer already started is never handed over and a handed routine is
 *    never started here;
 *  - it takes the clock back only from that daemon's configure reply (`released`,
 *    or a set that no longer holds it), from where the daemon stood, so a slot the
 *    daemon ran is never run here and one it did not run is;
 *  - a push the daemon refused hands nothing over, so the routines it would have
 *    handed come straight back;
 *  - a paused clock keeps its host and runs nowhere; Resume starts it over there.
 *
 * Between the two owners nobody ticks: a slot that falls in that gap is a past
 * `nextRunAtMs` when the server takes the clock back, and the timer runs it at
 * once (one run for however many were missed, the timer's own catch-up rule).
 */

import type { ClockReport } from '../../providers/trigger-clock-core.js';
import { CLOCK_ROUTINE_CAPABILITY } from '../../providers/trigger-clock-core.js';
import type { CronJob, CronServiceState } from './types.js';
import { isClockOwned, scheduleNextRunAtMs } from './jobs.js';
import { ensureLoaded, persist } from './store.js';
import { armTimer, emit, locked, replayGuardOf } from './timer.js';

export { CLOCK_ROUTINE_CAPABILITY };

/** What a host's push carries of the clocks it holds, and what changed hands. */
export interface ClockPlacement {
  /** Routines whose clock this host holds after the call, as stored. */
  owned: CronJob[];
  /** Handed to this host by this call. */
  handed: string[];
  /** Taken back by this call without a reply (the host is gone from the config). */
  released: string[];
}

export interface PlaceClocksOptions {
  /** Routines whose work runs on this host now (the routines layer decided). */
  wanted: ReadonlySet<string>;
  /** False: this host's daemon cannot hold a clock (or has not said it can): hand nothing over. */
  handover: boolean;
  /** Hosts in the config. A clock held by a host no longer there comes back to the server. */
  knownHosts: ReadonlySet<string>;
  /** Re-checked under the lock: the routine may have changed since `wanted` was computed. */
  eligible: (job: CronJob) => boolean;
}

/** The daemon's answer to a push: what it holds and what it gave back. Absent `clocks`: a daemon with no clocks at all. */
export interface ClockReply {
  clocks?: ClockReport[];
  released?: ClockReport[];
}

/**
 * The first slot a daemon would own if it took the clock now: the slot this
 * server has not run yet (a past one included: the daemon catches it up once),
 * never one the replay guard says already ran.
 */
export function handoverFromMs(state: CronServiceState, job: CronJob, nowMs: number): number | undefined {
  if (!job.enabled) return undefined;
  const guard = replayGuardOf(state).get(job.id);
  if (guard === null) return undefined;
  let next = typeof job.state.nextRunAtMs === 'number' ? job.state.nextRunAtMs : scheduleNextRunAtMs(job, nowMs);
  if (next === undefined) return undefined;
  if (typeof guard === 'number' && next < guard) next = guard;
  return next;
}

/**
 * Give the clock back to this server's timer, at `nextRunAtMs`. A slot already
 * past is one nobody ran (a run the daemon gave back, or one that fell between
 * the two owners): it stays due until the timer runs it.
 */
function takeBack(job: CronJob, nextRunAtMs: number | undefined, nowMs: number): void {
  delete job.state.clockHost;
  delete job.state.clockFromMs;
  job.state.nextRunAtMs = job.enabled ? nextRunAtMs : undefined;
  if (job.enabled && typeof nextRunAtMs === 'number' && nextRunAtMs <= nowMs) job.state.clockCatchUpAtMs = nextRunAtMs;
  else delete job.state.clockCatchUpAtMs;
}

/**
 * Decide which clocks `host` holds for the push about to go out. A routine
 * another host holds is left alone: it moves only after that host gives it back.
 */
export async function placeClocks(state: CronServiceState, host: string, opts: PlaceClocksOptions): Promise<ClockPlacement> {
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const now = state.deps.nowMs();
    const out: ClockPlacement = { owned: [], handed: [], released: [] };
    let changed = false;
    for (const job of state.store?.jobs ?? []) {
      if (!job.state) job.state = {};
      const holder = job.state.clockHost;
      if (holder !== undefined && !opts.knownHosts.has(holder)) {
        // The host is gone from the config: nobody will ever answer for it.
        takeBack(job, job.state.nextRunAtMs ?? scheduleNextRunAtMs(job, now), now);
        out.released.push(job.id);
        changed = true;
        state.deps.log.info('clock routine taken back: its host is no longer configured', { jobId: job.id, host: holder });
        continue;
      }
      if (holder !== undefined && holder !== host) continue;
      if (holder === host) {
        // Kept while it still belongs here; otherwise left out of the push, and the
        // reply's `released` gives it back. A paused one is left out too, but it
        // keeps its host (settleClocks).
        if (opts.wanted.has(job.id) && opts.eligible(job)) out.owned.push(job);
        continue;
      }
      if (!opts.handover || !opts.wanted.has(job.id) || !opts.eligible(job)) continue;
      // A run the timer started stays the timer's; the next push hands it over.
      if (typeof job.state.runningAtMs === 'number') continue;
      const fromMs = handoverFromMs(state, job, now);
      if (fromMs === undefined) continue;
      job.state.clockHost = host;
      job.state.clockFromMs = fromMs;
      job.state.nextRunAtMs = fromMs;
      delete job.state.clockCatchUpAtMs;
      out.handed.push(job.id);
      out.owned.push(job);
      changed = true;
      state.deps.log.info('clock routine handed to its host', { jobId: job.id, host, fromMs });
    }
    if (changed) {
      await persist(state);
      armTimer(state);
      for (const id of [...out.handed, ...out.released]) {
        const job = state.store?.jobs.find((j) => j.id === id);
        emit(state, { jobId: id, action: 'updated', nextRunAtMs: job?.state.nextRunAtMs });
      }
    }
    return { ...out, owned: out.owned.map((j) => structuredClone(j)) };
  });
}

/**
 * The daemon accepted the push: record where each clock it holds stands, and take
 * back every running clock of this host it does not hold. `released` says where a given-back
 * clock stood; a clock the server started over since (an edit, a resume) starts
 * from its own new slot instead, and a run the daemon gave back with it is that
 * old clock's.
 */
export async function settleClocks(state: CronServiceState, host: string, reply: ClockReply): Promise<string[]> {
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const now = state.deps.nowMs();
    const held = new Map((Array.isArray(reply.clocks) ? reply.clocks : []).map((c) => [c.id, c]));
    const gaveBack = new Map((Array.isArray(reply.released) ? reply.released : []).map((c) => [c.id, c]));
    const takenBack: string[] = [];
    let changed = false;
    for (const job of state.store?.jobs ?? []) {
      if (!job.state || job.state.clockHost !== host) continue;
      const mark = job.state.clockFromMs;
      const c = held.get(job.id);
      if (c) {
        // Only a report on the current handover says where this clock stands.
        if (c.fromMs === mark && job.enabled && job.state.nextRunAtMs !== c.nextRunAtMs) {
          job.state.nextRunAtMs = c.nextRunAtMs;
          changed = true;
        }
        continue;
      }
      // A paused clock stays with its host, armed nowhere: nothing runs while it is
      // paused (a run the daemon owed is dropped, as a pause drops one here), it
      // stays on its task, and Resume starts it over there (restartHostClock).
      if (!job.enabled) continue;
      const r = gaveBack.get(job.id);
      let next: number | undefined;
      if (r && r.fromMs === mark) {
        next = r.nextRunAtMs;
        if (typeof r.owedSlotMs === 'number') next = next === undefined ? r.owedSlotMs : Math.min(next, r.owedSlotMs);
      } else {
        next = typeof job.state.nextRunAtMs === 'number' ? job.state.nextRunAtMs : scheduleNextRunAtMs(job, now);
      }
      takeBack(job, next, now);
      takenBack.push(job.id);
      changed = true;
      state.deps.log.info('clock routine taken back from its host', {
        jobId: job.id, host, nextRunAtMs: job.state.nextRunAtMs ?? null,
        ...(r?.owedSlotMs !== undefined ? { owedSlotMs: r.owedSlotMs } : {}),
        reported: r ? (r.fromMs === mark ? 'released' : 'released-older') : 'absent',
      });
    }
    if (changed) {
      await persist(state);
      armTimer(state);
      for (const job of state.store?.jobs ?? []) {
        if (takenBack.includes(job.id)) emit(state, { jobId: job.id, action: 'updated', nextRunAtMs: job.state.nextRunAtMs });
      }
    }
    return takenBack;
  });
}

/** The daemon refused the push: it armed nothing, so what this push handed over comes back as it was. */
export async function revertClocks(state: CronServiceState, host: string, handed: readonly string[]): Promise<void> {
  if (handed.length === 0) return;
  await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const now = state.deps.nowMs();
    let changed = false;
    for (const job of state.store?.jobs ?? []) {
      if (!handed.includes(job.id) || job.state?.clockHost !== host) continue;
      takeBack(job, job.state.nextRunAtMs, now);
      changed = true;
      state.deps.log.warn('clock routine handover refused by its host; the server keeps it', { jobId: job.id, host });
    }
    if (changed) {
      await persist(state);
      armTimer(state);
    }
  });
}

/** Clocks held by hosts no longer in the config come back (boot, before any host answers). */
export async function releaseOrphanClocks(state: CronServiceState, knownHosts: ReadonlySet<string>): Promise<string[]> {
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const now = state.deps.nowMs();
    const out: string[] = [];
    for (const job of state.store?.jobs ?? []) {
      if (!job.state || !isClockOwned(job) || knownHosts.has(job.state.clockHost!)) continue;
      state.deps.log.info('clock routine taken back: its host is no longer configured', { jobId: job.id, host: job.state.clockHost });
      takeBack(job, job.state.nextRunAtMs ?? scheduleNextRunAtMs(job, now), now);
      out.push(job.id);
    }
    if (out.length > 0) {
      await persist(state);
      armTimer(state);
    }
    return out;
  });
}
