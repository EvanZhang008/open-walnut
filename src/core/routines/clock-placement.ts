/**
 * Where a routine's clock runs (clock-routine-v1, docs/plan/walnut-trigger.md
 * "Clock routines"): a routine runs where its work runs.
 *
 *  - `session`: its target task's session runs on a configured remote host. That
 *    host's daemon fires on the schedule and delivers into the session there, the
 *    way it delivers a trigger fire, so the run happens while the Mac sleeps.
 *  - `claude-code` with a remote `host`: that host's daemon decides when it fires;
 *    the Mac starts the session there when it takes the fire, as it does today.
 *    A fire the Mac was asleep for runs on the host itself when the def carries a
 *    `start` (clock-host-start-v1, routineStartOf below: the daemon starts the CLI
 *    from this Mac's routine spawn template and journals the run's task and
 *    session); without one it waits on the host and runs once the Mac is back.
 *  - Everything else stays on the server's timer exactly as before: main-agent,
 *    walnut-agent, watcher, a claude-code routine on the Mac, a routine whose host
 *    is unknown, one with a check, a wake counter or an init action, and a
 *    schedule only croner reads (clock-schedule-core.ts `supports`).
 *
 * A portable routine (clock-portable.ts) is the exception to "a routine runs where its work
 * runs": it has no host, so while this Mac is awake its clock may go to a connected, free,
 * always-on host that starts the run itself when the Mac is asleep. The routine's own host
 * setting stays as configured; a routine bound to a host keeps today's placement.
 *
 * This file decides which routines belong to which host; the handover itself
 * (who ticks, never twice) is cron/clock-handover.ts. Three guards keep a clock
 * from moving on bad information: a config that could not be read names no
 * hosts, so nothing moves; a def a daemon refused is not handed to it again
 * until the def or the connection changes; and a clock on a host that is not
 * connected comes back only when the routine plainly no longer belongs there.
 */

import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { MIN_EVERY_MS } from '../../providers/trigger-check-core.js';
import type { TriggerDef } from '../../providers/trigger-check-core.js';
import type { ClockStartSpec } from '../../providers/trigger-clock-core.js';
import type { ClockScheduleSpec } from '../../providers/clock-schedule-core.js';
import { clockSchedule, serverTimeZone } from '../cron/schedule.js';
import { cloudModeSkipsJob, resolveEveryAnchorMs } from '../cron/jobs.js';
import type { ClockReply } from '../cron/clock-handover.js';
import type { CronJob } from '../cron/types.js';
import { pickDeliverySession, type DeliverySessionCandidate } from './session-target.js';
import { deliverSpecOf, promptOf } from './trigger-push.js';
import {
  _ownerWatchForTest, _resetClockWatchForTest, dropOwner, OWNER_REFRESH_MS, ownerJobIds, scheduleClockPlacement, setOwner, setWatchedTasks,
  startClockPlacementWatch, watchTask,
} from './clock-placement-watch.js';
import { routineStartOf } from './clock-routine-start.js';
import { isOfflinePortable, offlineOwnerIdOf, offlineRoutineStartOf } from './offline-run.js';
import {
  defaultPortableClockEnv, portableBudgetMs, portableClaudeConfigOf, portableSeatOf, withinBudget,
  type OfflineClockWork, type PortableClockEnv, type PortableKind,
} from './clock-portable.js';

/** Executors whose work runs on one host, and so whose clock can live there. */
const CLOCK_EXECUTORS = new Set(['session', 'claude-code']);

/** What a daemon said about clocks in its hello: it holds them, it cannot, or it never said. */
export type ClockCapability = 'yes' | 'no' | 'unknown';

/** The schedule as a daemon runs it: a cron names its zone and an `every` its anchor, never guessed on a host. */
export function wireScheduleOf(job: CronJob): ClockScheduleSpec | null {
  const s = job.schedule;
  if (s.kind === 'cron') return { kind: 'cron', expr: s.expr, tz: (typeof s.tz === 'string' && s.tz.trim()) || serverTimeZone() };
  if (s.kind === 'every') return { kind: 'every', everyMs: Math.floor(s.everyMs), anchorMs: resolveEveryAnchorMs(s, job.createdAtMs) };
  if (s.kind === 'at') return { kind: 'at', at: s.at };
  return null;
}

/**
 * What every clock routine shares, whoever's work it is: enabled, nothing that needs this
 * Mac in front of the run (a check, a wake counter, an init action: an init processor
 * builds the run's input on this Mac, so such a routine never moves), and a schedule a
 * host's daemon reads the way croner does.
 */
function clockBaseOk(job: CronJob): boolean {
  if (!job.enabled || job.check || job.wake || job.initProcessor) return false;
  if (cloudModeSkipsJob(job)) return false;
  const wire = wireScheduleOf(job);
  if (!wire || !clockSchedule.supports(wire)) return false;
  return !(wire.kind === 'every' && wire.everyMs < MIN_EVERY_MS);
}

/** Everything about a routine that decides it, except where its work runs. */
export function clockCandidate(job: CronJob): boolean {
  if (!clockBaseOk(job)) return false;
  if (!CLOCK_EXECUTORS.has(job.executor?.type ?? '')) return false;
  if (!promptOf(job).trim()) return false;
  // A session routine is delivered on the host; one whose prompt cannot ride the def stays here.
  if (job.executor?.type === 'session' && !deliverSpecOf(job)) return false;
  return true;
}

export interface PlacementDeps {
  /** The configured remote hosts (config.hosts keys); null when config.yaml could not be read. */
  hosts(): Promise<Set<string> | null>;
  getTask(taskId: string): Promise<{ id: string; phase?: string; transferred_to?: string } | null>;
  sessionsForTask(taskId: string): Promise<DeliverySessionCandidate[]>;
  /** Whether that host's daemon is connected now. */
  connected?(host: string): Promise<boolean>;
  /** What that host may start a claude-code routine's run from (routineStartOf); absent: never. */
  routineStart?(job: CronJob, host: string, at?: { cwd: string }): Promise<ClockStartSpec | null>;
  /**
   * The facts a portable routine's clock host is judged by (clock-portable.ts); absent: no
   * routine is portable, every clock stays bound to its work's host.
   */
  portable?: PortableClockEnv;
  /** Routines other than claude-code runs that a detached worker may run offline (offline-run.ts); absent: none. */
  offline?: OfflineClockWork;
}

/**
 * Whether a routine's clock may be delegated to an always-on host, and as which kind of
 * work. Sync: the same shape test a claude-code routine's own config passes, or the
 * offline-run seam's. `allowed` is the switch read for this push (backup leader on).
 */
export function portableKindOf(job: CronJob, deps: Pick<PlacementDeps, 'portable' | 'offline'>, allowed: boolean): PortableKind | null {
  if (!allowed || !deps.portable || !clockBaseOk(job)) return null;
  if (clockCandidate(job) && portableClaudeConfigOf(job) && promptOf(job).trim()) return 'claude';
  return deps.offline?.portable(job) ? 'offline' : null;
}

/** A routine this layer ever places: bound to its work's host, or portable. */
function placeable(job: CronJob, deps: PlacementDeps, allowed: boolean): boolean {
  return clockCandidate(job) || portableKindOf(job, deps, allowed) !== null;
}

/** Test seam: external facts a test names in place of the real readers, merged over the real wiring. */
let depsOverride: Partial<PlacementDeps> | null = null;
export function __setClockPlacementDepsForTesting(next: Partial<PlacementDeps> | null): void { depsOverride = next; }

export function defaultPlacementDeps(): PlacementDeps {
  return { ...realPlacementDeps(), ...(depsOverride ?? {}) };
}

function realPlacementDeps(): PlacementDeps {
  return {
    async hosts() {
      const { getConfig, isFallbackConfig } = await import('../config-manager.js');
      const config = await getConfig();
      if (isFallbackConfig(config)) return null;
      return new Set(Object.keys(config.hosts ?? {}).filter((h) => h && h !== '__local__'));
    },
    async connected(host) {
      const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
      return getConnectedDaemonConnection(host) !== null;
    },
    async getTask(taskId) {
      const { getTask } = await import('../task-manager.js');
      return await getTask(taskId).catch(() => null);
    },
    async sessionsForTask(taskId) {
      const { getSessionsForTask } = await import('../session-tracker.js');
      return await getSessionsForTask(taskId).catch(() => []);
    },
    routineStart: (job, host, at) => routineStartOf(job, host, WALNUT_HOME, at),
    portable: defaultPortableClockEnv(),
    offline: { portable: (job) => isOfflinePortable(job), startOf: (job, host) => offlineRoutineStartOf(job, host), ownerOf: (job) => offlineOwnerIdOf(job) },
  };
}

/**
 * The host a routine's work runs on, when that is a configured remote host.
 * `reachableHost` is the host being pushed to: it is up, so a session there that
 * an outage left in error still counts (pickDeliverySession).
 */
export async function workHostOf(
  job: CronJob,
  deps: PlacementDeps,
  hosts: ReadonlySet<string>,
  reachableHost?: string,
): Promise<{ host: string; taskId?: string } | null> {
  const type = job.executor?.type;
  const config = (job.executor?.config ?? {}) as Record<string, unknown>;
  if (type === 'claude-code') {
    const host = typeof config.host === 'string' ? config.host.trim() : '';
    return host && hosts.has(host) ? { host } : null;
  }
  if (type !== 'session') return null;
  // A task moved to another host (task_transfer) points at the one that took the
  // work over: the run follows it there, as the session executor's does.
  let taskId = typeof config.target === 'string' ? config.target.trim() : '';
  if (!taskId) return null;
  let task = await deps.getTask(taskId);
  for (let hop = 0; hop < 8 && task?.phase === 'COMPLETE' && task.transferred_to; hop++) {
    taskId = task.transferred_to;
    task = await deps.getTask(taskId);
  }
  // A complete or missing target is the server's to report (session executor).
  if (!task || task.phase === 'COMPLETE') return null;
  const picked = pickDeliverySession(await deps.sessionsForTask(taskId), reachableHost ? { reachableHost } : {});
  const host = picked?.host;
  return host && hosts.has(host) ? { host, taskId } : null;
}

/**
 * One clock routine as a host's daemon arms it. `notBeforeMs` is its last run:
 * the daemon runs no slot at or before it, also one this server (or an older
 * Mac that did not know the clock had moved) already ran.
 */
export function clockDefOf(
  job: CronJob, taskId: string | undefined, home: string = WALNUT_HOME, start?: ClockStartSpec | null, withDeliver = true,
): TriggerDef | null {
  const wire = wireScheduleOf(job);
  const fromMs = job.state.clockFromMs;
  if (!wire || typeof fromMs !== 'number') return null;
  // A portable routine's work is no session on this host: nothing is delivered, the host starts it.
  const deliver = withDeliver ? deliverSpecOf(job, home) : null;
  const last = job.state.lastRunAtMs;
  return {
    id: job.id,
    name: job.name,
    everyMs: wire.kind === 'every' ? wire.everyMs : 0,
    clock: { schedule: wire, fromMs, ...(typeof last === 'number' && Number.isFinite(last) ? { notBeforeMs: last } : {}) },
    ...(deliver ? { deliver: { ...deliver, taskId: taskId ?? deliver.taskId } } : {}),
    ...(!deliver && start ? { start } : {}),
  };
}

/** What a refusal is about: the def as the daemon read it, minus where the clock stands. */
function refusalKeyOf(job: CronJob, taskId: string | undefined): string {
  const deliver = deliverSpecOf(job);
  return JSON.stringify([job.name, wireScheduleOf(job), deliver ? { ...deliver, taskId: taskId ?? deliver.taskId } : null]);
}

/**
 * Clock defs a host's daemon refused, by host then routine: the refusal key of
 * each. Such a routine stays on the server instead of being handed over (and
 * refused) on every push, until its def changes or the host connects anew.
 */
const refusedClocks = new Map<string, Map<string, string>>();

/** The cron service half placement needs (cron/service.ts). */
export interface ClockService {
  placeClocks: (host: string, opts: {
    wanted: ReadonlySet<string>; handover: boolean; knownHosts: ReadonlySet<string> | null; eligible: (job: CronJob) => boolean;
  }) => Promise<{ owned: CronJob[]; handed: string[] }>;
  settleClocks: (host: string, reply: ClockReply) => Promise<string[]>;
  revertClocks: (host: string, handed: readonly string[]) => Promise<void>;
  takeBackStranded?: (host: string, ids: readonly string[]) => Promise<string[]>;
}

/** The clock defs for one host's push, and what to do with the daemon's answer to it. */
export interface HostClocks {
  defs: TriggerDef[];
  handed: string[];
  applied: (reply: Record<string, unknown>) => Promise<void>;
  rejected: () => Promise<void>;
}

export async function placeClocksForHost(
  service: ClockService,
  host: string,
  jobs: CronJob[],
  capability: ClockCapability,
  deps: PlacementDeps = defaultPlacementDeps(),
  opts: { fresh?: boolean; hostStart?: boolean } = {},
): Promise<HostClocks> {
  const hosts = await deps.hosts();
  // A daemon met anew (a restart, an upgrade) is asked again about what it refused.
  if (opts.fresh) refusedClocks.delete(host);
  const refusedHere = refusedClocks.get(host);
  const wanted = new Set<string>();
  const taskOf = new Map<string, string>();
  // Portable routines placed here (clock-portable.ts), and what the host starts for each.
  const portableStart = new Map<string, ClockStartSpec | null>();
  // Starts the daemon accepted earlier, sent again as they were where this push cannot rebuild them.
  const retained = new Map<string, ClockStartSpec>();
  // Read once per push, and before any candidate is judged: off means no portable clock is placed, and a held one is given back.
  const allowed = deps.portable ? await deps.portable.allowed().catch(() => false) : false;
  const deadlineMs = Date.now() + portableBudgetMs();
  if (!hosts) {
    // The config could not be read: every clock stays where it is, and none moves.
    for (const job of jobs) {
      if (job.state?.clockHost !== host) continue;
      // A pause must disarm even if the host config cannot be read. An accepted
      // start is retained only for this enabled routine. After a server restart
      // with no cached start, leave it out and wait for the daemon's release reply.
      if (!job.enabled) continue;
      if (job.state.clockStarts === true) {
        const kept = acceptedStarts.get(acceptedKey(host, job.id));
        if (kept) retained.set(job.id, kept);
        else continue;
      }
      wanted.add(job.id);
      const work = await workHostOf(job, deps, new Set([host]), host).catch(() => null);
      if (work?.taskId) taskOf.set(job.id, work.taskId);
      // An offline routine's def is its start alone: with none it would be empty, so it is left out (the push gives it back).
      if (portableKindOf(job, deps, allowed) === 'claude' && !work) portableStart.set(job.id, null);
    }
    log.cron.warn('clock placement: hosts unknown (config unreadable), clocks stay where they are', { host });
  } else if (host !== '__local__' && hosts.has(host)) {
    for (const job of jobs) {
      const kind = portableKindOf(job, deps, allowed);
      if (!clockCandidate(job) && !kind) continue;
      // Held by another host: it moves only after that host gives it back.
      if (job.state?.clockHost && job.state.clockHost !== host) continue;
      const work = clockCandidate(job) ? await workHostOf(job, deps, hosts, host).catch(() => null) : null;
      // The task a transfer moved the work to is watched too: its session starts later.
      if (work?.taskId) watchTask(work.taskId);
      let bound = work;
      if (work && work.host !== host) {
        // A routine that declares itself portable (placement.portable) is not tied to the host it names:
        // an always-on host takes its clock while no host holds it, and its configured host is left as it is.
        // A clock this host holds already stays until a daemon's reply gives it back; one another host
        // holds (its own named host included) is never taken.
        const free = !job.state?.clockHost || job.state.clockHost === host;
        if (!(kind === 'claude' && free)) continue;
        bound = null;
      }
      // Its own host takes the clock of a routine that declares itself portable only as any host does: always-on and
      // fit, and only while no host holds it. Held by this host already, it stays (conservative: no reshuffle).
      if (bound && kind === 'claude' && !job.state?.clockHost) bound = null;
      if (bound) {
        if (!job.state?.clockHost && refusedHere?.get(job.id) === refusalKeyOf(job, bound.taskId)) continue;
        wanted.add(job.id);
        if (bound.taskId) taskOf.set(job.id, bound.taskId);
        continue;
      }
      // No host of its own: a portable routine goes to a host that stays up.
      if (!kind) continue;
      const held = job.state?.clockHost === host;
      if (!held && (capability !== 'yes' || refusedHere?.get(job.id) === refusalKeyOf(job, undefined))) continue;
      const seat = await portableSeatOf(job, kind, host, deps.portable!, { held, deadlineMs }).catch((err: unknown) => ({
        ok: false as const, unknown: true, why: err instanceof Error ? err.message : String(err),
      }));
      if (!seat.ok) {
        noteSeatVerdict(host, job.id, seat.why, { held, unknown: seat.unknown });
        // A fact not known (its capabilities, its home) keeps a clock where it is; a plain no gives it back.
        if (!held || !seat.unknown) continue;
      }
      // The host starts the run itself while this Mac is away, or the clock gains nothing: a new handover needs that.
      // undefined: it cannot be told now (a fact not known, a start that did not answer in time).
      let start: ClockStartSpec | null | undefined = capability === 'yes' && opts.hostStart && seat.ok
        ? await withinBudget(kind === 'claude'
          ? (seat.cwd ? deps.routineStart?.(job, host, { cwd: seat.cwd }) : null)
          : deps.offline?.startOf(job, host), deadlineMs)
        : held ? undefined : null;
      if (start === undefined && held && job.state?.clockStarts === true) {
        // The daemon holds a start this server accepted: keep exactly that one (only this routine's def), and the
        // rest of the set goes on as it is, a pause or a delete elsewhere in it included. None on record: it goes back.
        start = acceptedStarts.get(acceptedKey(host, job.id)) ?? null;
        if (!start) continue;
        retained.set(job.id, start);
      }
      start ??= null;
      // A routine the host cannot start stays on its own path (its delivery, or the server timer): a new
      // handover needs the start, and an offline routine's def is nothing without one.
      if (!start && (!held || kind === 'offline')) continue;
      if (kind === 'offline') await noteOwner(job, deps, deadlineMs);
      wanted.add(job.id);
      portableStart.set(job.id, start);
    }
  }
  const placed = await service.placeClocks(host, {
    wanted, handover: capability === 'yes' && hosts !== null, knownHosts: hosts,
    eligible: (job) => placeable(job, deps, allowed),
  });
  // An offline routine this host no longer holds is no longer watched through its owner.
  for (const id of ownerJobIds()) if (!placed.owned.some((j) => j.id === id) && !jobs.some((j) => j.id === id && j.state?.clockHost && j.state.clockHost !== host)) dropOwner(id);
  // A daemon that has not said it holds clocks gets none: an older one refuses
  // the whole set over a def it cannot read.
  const defs: TriggerDef[] = [];
  const starts: string[] = [];
  const sentStarts = new Map<string, ClockStartSpec>();
  if (capability === 'yes') {
    for (const job of placed.owned) {
      let def: TriggerDef | null;
      if (portableStart.has(job.id)) {
        def = clockDefOf(job, undefined, WALNUT_HOME, retained.get(job.id) ?? portableStart.get(job.id), false);
      } else if (retained.has(job.id)) {
        def = clockDefOf(job, taskOf.get(job.id), WALNUT_HOME, retained.get(job.id));
      } else {
        // A claude-code run the host may start itself while this Mac is away
        // (clock-host-start-v1): only for a daemon that can, holding the routine template.
        const start = opts.hostStart && job.executor?.type === 'claude-code' && deps.routineStart
          ? await deps.routineStart(job, host).catch(() => null)
          : null;
        def = clockDefOf(job, taskOf.get(job.id), WALNUT_HOME, start);
      }
      if (def) defs.push(def);
      if (def?.start) {
        starts.push(job.id);
        sentStarts.set(job.id, def.start);
      }
    }
  }
  const handed = placed.handed;
  return {
    defs,
    handed,
    applied: async (reply) => {
      const refused = Array.isArray(reply.refused) ? reply.refused as NonNullable<ClockReply['refused']> : [];
      const clockReply: ClockReply = {
        ...(Array.isArray(reply.clocks) ? { clocks: reply.clocks as ClockReply['clocks'] } : {}),
        ...(Array.isArray(reply.released) ? { released: reply.released as ClockReply['released'] } : {}),
        ...(refused.length ? { refused } : {}),
        starts,
      };
      rememberRefused(host, placed.owned, taskOf, refused);
      const back = await service.settleClocks(host, clockReply);
      // What the daemon accepted: the start it holds for each clock it reported (kept to send again where it cannot be rebuilt).
      const held = new Set((Array.isArray(reply.clocks) ? reply.clocks as Array<{ id?: string }> : []).map((c) => c.id));
      for (const id of new Set([...sentStarts.keys(), ...placed.owned.map((j) => j.id)])) {
        const spec = sentStarts.get(id);
        if (spec && held.has(id)) acceptedStarts.set(acceptedKey(host, id), spec);
        else acceptedStarts.delete(acceptedKey(host, id));
      }
      if (back.length > 0) log.cron.info('clock routines back on the server timer', { host, jobIds: back });
    },
    rejected: async () => {
      await service.revertClocks(host, handed);
    },
  };
}

/**
 * An offline routine's owner is watched, as a session routine's target is (its start carries a
 * sample of that conversation, so the def armed on the host goes stale as it moves).
 * Per routine, kept across pushes; a routine that is no longer placed forgets it (the loop in placeClocksForHost).
 */
async function noteOwner(job: CronJob, deps: PlacementDeps, deadlineMs: number): Promise<void> {
  const owner = await withinBudget(deps.offline?.ownerOf?.(job), deadlineMs);
  if (owner) setOwner(job.id, owner);
}

/** The start each daemon accepted for each clock (host and routine), as sent: this server's record of what the daemon holds. */
const acceptedStarts = new Map<string, ClockStartSpec>();
const acceptedKey = (host: string, jobId: string): string => `${host}\u0000${jobId}`;

/** Why a portable routine was not seated on a host, told at info once per change (a push repeats the same verdict). */
const seatVerdicts = new Map<string, string>();
function noteSeatVerdict(host: string, jobId: string, why: string, extra: { held: boolean; unknown: boolean }): void {
  const key = `${host}\u0000${jobId}`;
  if (seatVerdicts.get(key) === why) return;
  seatVerdicts.set(key, why);
  log.cron.info('clock placement: a portable routine is not placed on this host', { host, jobId, why, ...extra });
}

/** Remember the clock defs a daemon refused, so the next push does not hand them over again. */
function rememberRefused(
  host: string,
  sent: readonly CronJob[],
  taskOf: ReadonlyMap<string, string>,
  refused: ReadonlyArray<{ id?: string; error: string }>,
): void {
  for (const r of refused) {
    const job = sent.find((j) => j.id === r.id);
    if (!job) {
      if (r.id) log.cron.warn('trigger def refused by its host', { host, jobId: r.id, error: r.error });
      continue;
    }
    let byJob = refusedClocks.get(host);
    if (!byJob) refusedClocks.set(host, byJob = new Map());
    byJob.set(job.id, refusalKeyOf(job, taskOf.get(job.id)));
    log.cron.warn('clock routine refused by its host: it stays on the server', { host, jobId: job.id, error: r.error });
  }
}

/**
 * What belongsOn says of a held portable claude-code clock on a host that is not connected: `unknown`,
 * it stays. An unreachable host may still be running its own clock, and taking it back without a
 * lease or epoch from that daemon could start a slot on both sides. (A clock the daemon accepted a start
 * for is `unknown` before this is asked, whatever the routine is now; a clock that is only a delivery
 * follows its session's own rules, offline seam or not.) The cost is a missed slot while the host is away, never a second run.
 */
const PORTABLE_STRANDED = 'unknown' as const;

/**
 * Whether a routine still belongs to `host`, judged without asking that host
 * (it is not connected). `unknown` keeps the clock where it is: a session that
 * reads as gone because its host is unreachable says nothing about the routine.
 */
export async function belongsOn(
  job: CronJob,
  host: string,
  deps: PlacementDeps,
  hosts: ReadonlySet<string>,
): Promise<'yes' | 'no' | 'unknown'> {
  // A paused clock keeps its host (clock-handover.ts).
  if (!job.enabled) return 'yes';
  // The daemon accepted a start for it (clockStarts): it may start runs on its own while this Mac is away, and
  // a lost link says nothing of that. Whatever the routine looks like now, only the daemon's reply gives the clock back.
  if (job.state?.clockStarts === true) return 'unknown';
  const allowed = deps.portable ? await deps.portable.allowed().catch(() => false) : false;
  const kind = portableKindOf(job, deps, allowed);
  if (!clockCandidate(job) && !kind) return 'no';
  const config = (job.executor?.config ?? {}) as Record<string, unknown>;
  if (job.executor?.type === 'claude-code') {
    if (typeof config.host === 'string' && config.host.trim() === host) return 'yes';
    return kind ? PORTABLE_STRANDED : 'no';
  }
  let taskId = typeof config.target === 'string' ? config.target.trim() : '';
  let task = taskId ? await deps.getTask(taskId) : null;
  for (let hop = 0; hop < 8 && task?.phase === 'COMPLETE' && task.transferred_to; hop++) {
    taskId = task.transferred_to;
    task = await deps.getTask(taskId);
  }
  if (!task || task.phase === 'COMPLETE') return 'no';
  const picked = pickDeliverySession(await deps.sessionsForTask(taskId));
  if (!picked) return 'unknown';
  const at = picked.host || '__local__';
  return at === host ? 'yes' : (at === '__local__' || hosts.has(at)) ? 'no' : 'unknown';
}

/**
 * The clocks on hosts that are not connected which no longer belong there come
 * back to the server's timer (clock-handover.ts takeBackStranded). A connected
 * host gives its clocks back itself, through the push.
 */
export async function takeBackStrandedClocks(
  service: ClockService,
  jobs: CronJob[],
  deps: PlacementDeps = defaultPlacementDeps(),
): Promise<string[]> {
  if (!service.takeBackStranded) return [];
  const hosts = await deps.hosts();
  if (!hosts) return [];
  const byHost = new Map<string, string[]>();
  for (const job of jobs) {
    const holder = job.state?.clockHost;
    if (!holder || !hosts.has(holder)) continue;
    if (await deps.connected?.(holder).catch(() => true) ?? true) continue;
    if ((await belongsOn(job, holder, deps, hosts).catch(() => 'unknown' as const)) !== 'no') continue;
    byHost.set(holder, [...(byHost.get(holder) ?? []), job.id]);
  }
  const out: string[] = [];
  for (const [host, ids] of byHost) out.push(...await service.takeBackStranded(host, ids));
  return out;
}

// ── keep placement fresh: watch state and the throttled re-push live in clock-placement-watch.ts ──

/** Remember which tasks matter, so the bus watch can ignore every other task. */
export function noteWatchedTasks(jobs: readonly CronJob[]): void {
  const next = new Set<string>();
  for (const job of jobs) {
    if (job.executor?.type !== 'session' || !clockCandidate(job)) continue;
    const target = (job.executor.config as { target?: unknown } | undefined)?.target;
    if (typeof target === 'string' && target) next.add(target);
  }
  setWatchedTasks(next);
}

/** Tests: forget the watch state. */
export function _resetClockPlacementForTest(): void {
  _resetClockWatchForTest();
  refusedClocks.clear();
  seatVerdicts.clear();
  acceptedStarts.clear();
}

// The watch's exports stay reachable from here (callers and tests import them from this file).
export { _ownerWatchForTest, OWNER_REFRESH_MS, scheduleClockPlacement, startClockPlacementWatch };

export { routineStartOf };
