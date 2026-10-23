/**
 * Where a routine's clock runs (clock-routine-v1, docs/plan/walnut-trigger.md
 * "Clock routines"): a routine runs where its work runs.
 *
 *  - `session`: its target task's session runs on a configured remote host. That
 *    host's daemon fires on the schedule and delivers into the session there, the
 *    way it delivers a trigger fire, so the run happens while the Mac sleeps.
 *  - `claude-code` with a remote `host`: that host's daemon decides when it fires;
 *    the Mac starts the session there when it takes the fire, as it does today.
 *    A fire the Mac was asleep for waits on the host and runs once when it is back.
 *  - Everything else stays on the server's timer exactly as before: main-agent,
 *    walnut-agent, watcher, a claude-code routine on the Mac, a routine whose host
 *    is unknown, one with a check, a wake counter or an init action, and a
 *    schedule only croner reads (clock-schedule-core.ts `supports`).
 *
 * This file decides which routines belong to which host; the handover itself
 * (who ticks, never twice) is cron/clock-handover.ts.
 */

import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { MIN_EVERY_MS } from '../../providers/trigger-check-core.js';
import type { TriggerDef } from '../../providers/trigger-check-core.js';
import type { ClockScheduleSpec } from '../../providers/clock-schedule-core.js';
import { clockSchedule, serverTimeZone } from '../cron/schedule.js';
import { cloudModeSkipsJob, resolveEveryAnchorMs } from '../cron/jobs.js';
import type { ClockReply } from '../cron/clock-handover.js';
import type { CronJob } from '../cron/types.js';
import { pickDeliverySession, type DeliverySessionCandidate } from './session-target.js';
import { deliverSpecOf, promptOf } from './trigger-push.js';

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

/** Everything about a routine that decides it, except where its work runs. */
export function clockCandidate(job: CronJob): boolean {
  if (!job.enabled || job.check || job.wake || job.initProcessor) return false;
  if (!CLOCK_EXECUTORS.has(job.executor?.type ?? '')) return false;
  if (!promptOf(job).trim()) return false;
  if (cloudModeSkipsJob(job)) return false;
  const wire = wireScheduleOf(job);
  if (!wire || !clockSchedule.supports(wire)) return false;
  if (wire.kind === 'every' && wire.everyMs < MIN_EVERY_MS) return false;
  // A session routine is delivered on the host; one whose prompt cannot ride the def stays here.
  if (job.executor?.type === 'session' && !deliverSpecOf(job)) return false;
  return true;
}

export interface PlacementDeps {
  /** The configured remote hosts (config.hosts keys). */
  hosts(): Promise<Set<string>>;
  getTask(taskId: string): Promise<{ id: string; phase?: string; transferred_to?: string } | null>;
  sessionsForTask(taskId: string): Promise<DeliverySessionCandidate[]>;
}

export function defaultPlacementDeps(): PlacementDeps {
  return {
    async hosts() {
      const { getConfig } = await import('../config-manager.js');
      const config = await getConfig();
      return new Set(Object.keys(config.hosts ?? {}).filter((h) => h && h !== '__local__'));
    },
    async getTask(taskId) {
      const { getTask } = await import('../task-manager.js');
      return await getTask(taskId).catch(() => null);
    },
    async sessionsForTask(taskId) {
      const { getSessionsForTask } = await import('../session-tracker.js');
      return await getSessionsForTask(taskId).catch(() => []);
    },
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

/** One clock routine as a host's daemon arms it. */
export function clockDefOf(job: CronJob, taskId: string | undefined, home: string = WALNUT_HOME): TriggerDef | null {
  const wire = wireScheduleOf(job);
  const fromMs = job.state.clockFromMs;
  if (!wire || typeof fromMs !== 'number') return null;
  const deliver = deliverSpecOf(job, home);
  return {
    id: job.id,
    name: job.name,
    everyMs: wire.kind === 'every' ? wire.everyMs : 0,
    clock: { schedule: wire, fromMs },
    ...(deliver ? { deliver: { ...deliver, taskId: taskId ?? deliver.taskId } } : {}),
  };
}

/** The cron service half placement needs (cron/service.ts). */
export interface ClockService {
  placeClocks: (host: string, opts: {
    wanted: ReadonlySet<string>; handover: boolean; knownHosts: ReadonlySet<string>; eligible: (job: CronJob) => boolean;
  }) => Promise<{ owned: CronJob[]; handed: string[] }>;
  settleClocks: (host: string, reply: ClockReply) => Promise<string[]>;
  revertClocks: (host: string, handed: readonly string[]) => Promise<void>;
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
): Promise<HostClocks> {
  const hosts = await deps.hosts();
  const wanted = new Set<string>();
  const taskOf = new Map<string, string>();
  if (host !== '__local__' && hosts.has(host)) {
    for (const job of jobs) {
      if (!clockCandidate(job)) continue;
      // Held by another host: it moves only after that host gives it back.
      if (job.state?.clockHost && job.state.clockHost !== host) continue;
      const work = await workHostOf(job, deps, hosts, host).catch(() => null);
      // The task a transfer moved the work to is watched too: its session starts later.
      if (work?.taskId) watchedTasks.add(work.taskId);
      if (work?.host !== host) continue;
      wanted.add(job.id);
      if (work.taskId) taskOf.set(job.id, work.taskId);
    }
  }
  const placed = await service.placeClocks(host, { wanted, handover: capability === 'yes', knownHosts: hosts, eligible: clockCandidate });
  // A daemon that has not said it holds clocks gets none: an older one refuses
  // the whole set over a def it cannot read.
  const defs = capability === 'yes'
    ? placed.owned.map((job) => clockDefOf(job, taskOf.get(job.id))).filter((d): d is TriggerDef => d !== null)
    : [];
  const handed = placed.handed;
  return {
    defs,
    handed,
    applied: async (reply) => {
      const clockReply: ClockReply = {
        ...(Array.isArray(reply.clocks) ? { clocks: reply.clocks as ClockReply['clocks'] } : {}),
        ...(Array.isArray(reply.released) ? { released: reply.released as ClockReply['released'] } : {}),
      };
      const back = await service.settleClocks(host, clockReply);
      if (back.length > 0) log.cron.info('clock routines back on the server timer', { host, jobIds: back });
    },
    rejected: async () => {
      await service.revertClocks(host, handed);
    },
  };
}

// ── keep placement fresh: a routine's session can appear on a host later ──

let watchStarted = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Task ids a session routine targets (and the tasks they moved to), refreshed on each schedule. */
let watchedTasks = new Set<string>();
const REPLACE_DEBOUNCE_MS = 3_000;

/** Re-place every connected host's clocks soon (a burst becomes one push per host). */
export function scheduleClockPlacement(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void import('../../providers/daemon-connection.js')
      .then(({ pushTriggersToAllHosts }) => pushTriggersToAllHosts())
      .catch((err) => log.cron.warn('clock placement: re-push failed', { error: err instanceof Error ? err.message : String(err) }));
  }, REPLACE_DEBOUNCE_MS);
  timer.unref?.();
}

/** Remember which tasks matter, so the bus watch can ignore every other task. */
export function noteWatchedTasks(jobs: readonly CronJob[]): void {
  const next = new Set<string>();
  for (const job of jobs) {
    if (job.executor?.type !== 'session' || !clockCandidate(job)) continue;
    const target = (job.executor.config as { target?: unknown } | undefined)?.target;
    if (typeof target === 'string' && target) next.add(target);
  }
  watchedTasks = next;
}

function taskIdOf(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { taskId?: unknown; task?: { id?: unknown }; id?: unknown };
  if (typeof d.taskId === 'string') return d.taskId;
  if (d.task && typeof d.task.id === 'string') return d.task.id;
  return typeof d.id === 'string' ? d.id : undefined;
}

/** Started once at boot: a session that starts on a watched task, or a task that moves, re-places its routine. */
export function startClockPlacementWatch(): void {
  if (watchStarted) return;
  watchStarted = true;
  void import('../event-bus.js').then(({ bus }) => {
    bus.subscribe('clock-placement', (event) => {
      if (watchedTasks.size === 0) return;
      const taskId = taskIdOf(event.data);
      if (taskId && watchedTasks.has(taskId)) scheduleClockPlacement();
    }, { global: true, interest: ['session:started', 'task:updated', 'task:completed', 'task:deleted'] });
  });
}

/** Tests: forget the watch state. */
export function _resetClockPlacementForTest(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  watchedTasks = new Set();
}
