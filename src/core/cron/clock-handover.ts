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
 *  - it takes the clock back from that daemon's configure reply (`released`, or a
 *    set that no longer holds it), from where the daemon stood: the server owns
 *    the slots from the daemon's next one, and the runs the daemon made before it
 *    still come as fires (the daemon keeps them until each is acked), which
 *    clock-fire.ts records or runs once (`state.clockReturned` says whose slots
 *    those were);
 *  - a push the daemon refused, or a def it refused alone, hands nothing over, so
 *    those routines come straight back;
 *  - a clock on a host that is not connected comes back without a reply only when
 *    the routine no longer belongs there (takeBackStranded); a run the host made
 *    meanwhile is matched by its slot when it arrives;
 *  - a paused clock keeps its host and runs nowhere; Resume starts it over there;
 *  - a config that could not be read names no hosts: that takes nothing back.
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
  /**
   * Hosts in the config. A clock held by a host no longer there comes back to the
   * server. null: the config could not be read, so no host counts as removed.
   */
  knownHosts: ReadonlySet<string> | null;
  /** Re-checked under the lock: the routine may have changed since `wanted` was computed. */
  eligible: (job: CronJob) => boolean;
}

/** The daemon's answer to a push: what it holds and what it gave back. Absent `clocks`: a daemon with no clocks at all. */
export interface ClockReply {
  clocks?: ClockReport[];
  released?: ClockReport[];
  /** Defs it could not take: the rest of the set was armed without them. */
  refused?: Array<{ id?: string; error: string }>;
  /**
   * The server's own note, not the daemon's: the routines whose def carried a `start`
   * (clock-host-start-v1), so the host starts their runs while this Mac is away.
   */
  starts?: string[];
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
 * Give the clock back to this server's timer, at `nextRunAtMs`: the slot the
 * daemon had not run (a past one stays due until the timer runs it; the
 * recompute never moves an unrun slot). The slots before it were the daemon's,
 * and the runs it made of them arrive as fires (clockReturned).
 */
function takeBack(job: CronJob, host: string, nextRunAtMs: number | undefined, armed = true): void {
  const mark = job.state.clockFromMs;
  delete job.state.clockHost;
  delete job.state.clockFromMs;
  delete job.state.clockStarts;
  job.state.nextRunAtMs = job.enabled ? nextRunAtMs : undefined;
  // A handover the daemon never armed made no runs: an earlier one's record stays.
  if (armed && typeof mark === 'number') {
    job.state.clockReturned = { host, fromMs: mark, ...(typeof nextRunAtMs === 'number' ? { beforeMs: nextRunAtMs } : {}) };
  }
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
      if (holder !== undefined && opts.knownHosts && !opts.knownHosts.has(holder)) {
        // The host is gone from the config: nobody will ever answer for it.
        takeBack(job, holder, job.state.nextRunAtMs ?? scheduleNextRunAtMs(job, now));
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
 * back every running clock of this host it does not hold (a def it refused
 * included). `released` says where a given-back clock stood; a clock the server
 * started over since (an edit, a resume) starts from its own new slot instead.
 */
export async function settleClocks(state: CronServiceState, host: string, reply: ClockReply): Promise<string[]> {
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const now = state.deps.nowMs();
    const held = new Map((Array.isArray(reply.clocks) ? reply.clocks : []).map((c) => [c.id, c]));
    const gaveBack = new Map((Array.isArray(reply.released) ? reply.released : []).map((c) => [c.id, c]));
    const refused = new Map((Array.isArray(reply.refused) ? reply.refused : []).filter((r) => typeof r?.id === 'string').map((r) => [r.id!, r.error]));
    const starts = new Set(Array.isArray(reply.starts) ? reply.starts : []);
    const takenBack: string[] = [];
    const restated: string[] = [];
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
        // Whether the host starts its runs while this Mac is away (the card says so).
        if (starts.has(job.id) !== (job.state.clockStarts === true)) {
          if (starts.has(job.id)) job.state.clockStarts = true;
          else delete job.state.clockStarts;
          restated.push(job.id);
          changed = true;
        }
        continue;
      }
      // A paused clock stays with its host, armed nowhere: nothing runs while it is
      // paused (a run the daemon owed is dropped, as a pause drops one here), it
      // stays on its task, and Resume starts it over there (restartHostClock).
      if (!job.enabled) continue;
      const r = gaveBack.get(job.id);
      const next = r && r.fromMs === mark
        ? r.nextRunAtMs
        : typeof job.state.nextRunAtMs === 'number' ? job.state.nextRunAtMs : scheduleNextRunAtMs(job, now);
      takeBack(job, host, next, !!r || !refused.has(job.id));
      takenBack.push(job.id);
      changed = true;
      state.deps.log.info('clock routine taken back from its host', {
        jobId: job.id, host, nextRunAtMs: job.state.nextRunAtMs ?? null,
        ...(r?.pending ? { pending: r.pending } : {}),
        reported: r ? (r.fromMs === mark ? 'released' : 'released-older') : refused.has(job.id) ? 'refused' : 'absent',
        ...(refused.has(job.id) ? { error: refused.get(job.id) } : {}),
      });
    }
    if (changed) {
      await persist(state);
      armTimer(state);
      for (const job of state.store?.jobs ?? []) {
        if (takenBack.includes(job.id) || restated.includes(job.id)) emit(state, { jobId: job.id, action: 'updated', nextRunAtMs: job.state.nextRunAtMs });
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
    let changed = false;
    for (const job of state.store?.jobs ?? []) {
      if (!handed.includes(job.id) || job.state?.clockHost !== host) continue;
      takeBack(job, host, job.state.nextRunAtMs, false);
      changed = true;
      state.deps.log.warn('clock routine handover refused by its host; the server keeps it', { jobId: job.id, host });
    }
    if (changed) {
      await persist(state);
      armTimer(state);
    }
  });
}

/**
 * Clocks held by hosts no longer in the config come back (boot, before any host
 * answers). null: the config could not be read, which says nothing about hosts.
 */
export async function releaseOrphanClocks(state: CronServiceState, knownHosts: ReadonlySet<string> | null): Promise<string[]> {
  if (!knownHosts) {
    state.deps.log.warn('clock routines: hosts unknown (config unreadable), no clock taken back');
    return [];
  }
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const now = state.deps.nowMs();
    const out: string[] = [];
    for (const job of state.store?.jobs ?? []) {
      if (!job.state || !isClockOwned(job) || knownHosts.has(job.state.clockHost!)) continue;
      const host = job.state.clockHost!;
      state.deps.log.info('clock routine taken back: its host is no longer configured', { jobId: job.id, host });
      takeBack(job, host, job.state.nextRunAtMs ?? scheduleNextRunAtMs(job, now));
      out.push(job.id);
    }
    if (out.length > 0) {
      await persist(state);
      armTimer(state);
    }
    return out;
  });
}

/**
 * Clocks a host holds that no longer belong there, while that host is not
 * connected to answer for them (the routines layer decided: clock-placement.ts).
 * The server runs them from the slot the host last reported; the host gives them
 * back when it reconnects, and a run it made meanwhile is matched by its slot
 * (clock-fire.ts): one the server ran too is not run again.
 */
export async function takeBackStranded(state: CronServiceState, host: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  return await locked(state, async () => {
    await ensureLoaded(state, { forceReload: true, skipRecompute: true });
    const now = state.deps.nowMs();
    const out: string[] = [];
    for (const job of state.store?.jobs ?? []) {
      if (!ids.includes(job.id) || job.state?.clockHost !== host || !job.enabled) continue;
      takeBack(job, host, job.state.nextRunAtMs ?? scheduleNextRunAtMs(job, now));
      out.push(job.id);
      state.deps.log.info('clock routine taken back: it left its unreachable host', { jobId: job.id, host, nextRunAtMs: job.state.nextRunAtMs ?? null });
    }
    if (out.length > 0) {
      await persist(state);
      armTimer(state);
      for (const id of out) {
        const job = state.store?.jobs.find((j) => j.id === id);
        emit(state, { jobId: id, action: 'updated', nextRunAtMs: job?.state.nextRunAtMs });
      }
    }
    return out;
  });
}
