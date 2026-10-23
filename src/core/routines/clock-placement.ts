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
import { START_TASK_TOKEN, validateClockStartSpec, type ClockStartSpec } from '../../providers/trigger-clock-core.js';
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
  /** The configured remote hosts (config.hosts keys); null when config.yaml could not be read. */
  hosts(): Promise<Set<string> | null>;
  getTask(taskId: string): Promise<{ id: string; phase?: string; transferred_to?: string } | null>;
  sessionsForTask(taskId: string): Promise<DeliverySessionCandidate[]>;
  /** Whether that host's daemon is connected now. */
  connected?(host: string): Promise<boolean>;
  /** What that host may start a claude-code routine's run from (routineStartOf); absent: never. */
  routineStart?(job: CronJob, host: string): Promise<ClockStartSpec | null>;
}

export function defaultPlacementDeps(): PlacementDeps {
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
    routineStart: (job, host) => routineStartOf(job, host),
  };
}

/**
 * What a host starts a claude-code routine's run from while this Mac is away
 * (clock-host-start-v1), or null when the run stays this Mac's to start. Every field
 * is the one this Mac's claude-code executor would use (executors/claude-code.ts,
 * quickStartSession): the instructions as the first message, the routine's folder,
 * model and title ("Routine: <name>" unless it names one, sent as the literal text),
 * its project ("Routines" unless it names one), the mode this Mac runs a routine in
 * (none named: DEFAULT_SESSION_MODE), the configured session effort, and the session
 * context this Mac would append, built for the run's task with START_TASK_TOKEN where
 * the id goes (the host mints it).
 *
 * Eligible only when the host can do what this Mac would do: an ordinary routine (no
 * console agent, no title template), instructions short enough to go inline (the Mac
 * spills longer ones to a file here) and naming no task or project pill (the Mac adds
 * their cards), an absolute folder, the Claude Code engine for that host, and no SDK
 * session server (which would run it another way).
 */
export async function routineStartOf(job: CronJob, host: string, home: string = WALNUT_HOME): Promise<ClockStartSpec | null> {
  if (job.executor?.type !== 'claude-code' || !host || host === '__local__') return null;
  const c = (job.executor.config ?? {}) as Record<string, unknown>;
  if ((typeof c.host === 'string' ? c.host.trim() : '') !== host) return null;
  if (c.walnutAgent === true || (typeof c.agentId === 'string' && c.agentId.trim()) || (typeof c.titleTemplate === 'string' && c.titleTemplate.trim())) return null;
  const message = promptOf(job);
  const cwd = typeof c.cwd === 'string' ? c.cwd.trim() : '';
  if (!message.trim() || !cwd.startsWith('/')) return null;
  const [{ QUICK_START_MESSAGE_SPILL_LIMIT }, { listEntityRefs }, { readTriageCountHint }] = await Promise.all([
    import('../../constants.js'), import('../../utils/entity-refs.js'), import('./executors/claude-code.js'),
  ]);
  if (message.length > QUICK_START_MESSAGE_SPILL_LIMIT || listEntityRefs(message).length > 0 || readTriageCountHint(message) !== undefined) return null;
  const [{ getConfig, isFallbackConfig }, { resolveDefaultEngine }, { normalizeEngine }, { DEFAULT_SESSION_MODE, VALID_SESSION_EFFORT_IDS }] = await Promise.all([
    import('../config-manager.js'), import('../agents/default-engine.js'), import('../agents/engine-registry.js'), import('../types.js'),
  ]);
  const config = await getConfig();
  if (isFallbackConfig(config) || !config.hosts?.[host] || config.session_server?.enabled) return null;
  if (normalizeEngine(resolveDefaultEngine(config, { host })) !== undefined) return null;
  const title = (typeof c.taskTitle === 'string' && c.taskTitle.trim()) || `Routine: ${job.name}`;
  const project = (typeof c.project === 'string' && c.project.trim()) || 'Routines';
  const model = typeof c.model === 'string' && c.model.trim() ? c.model.trim() : undefined;
  const effort = config.agent?.session_effort && VALID_SESSION_EFFORT_IDS.has(config.agent.session_effort) ? config.agent.session_effort : undefined;
  let context = '';
  try {
    const { buildSessionContext } = await import('../sessions/session-context.js');
    const task = { id: START_TASK_TOKEN, title, project } as unknown as import('../types.js').Task;
    context = (await buildSessionContext(START_TASK_TOKEN, cwd, host, { task })).systemPrompt;
  } catch (err) {
    // A run without its context would differ from this Mac's: it stays here.
    log.cron.warn('clock placement: no session context for a routine run on its host; it stays the Mac\'s to start', { host, jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const spec = validateClockStartSpec({
    home, host, title, project, cwd, message, mode: DEFAULT_SESSION_MODE,
    ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(context ? { context } : {}),
  });
  if (!spec.ok) {
    log.cron.debug('clock placement: a routine run cannot start on its host', { host, jobId: job.id, error: spec.error });
    return null;
  }
  return spec.spec;
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
export function clockDefOf(job: CronJob, taskId: string | undefined, home: string = WALNUT_HOME, start?: ClockStartSpec | null): TriggerDef | null {
  const wire = wireScheduleOf(job);
  const fromMs = job.state.clockFromMs;
  if (!wire || typeof fromMs !== 'number') return null;
  const deliver = deliverSpecOf(job, home);
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
  if (!hosts) {
    // The config could not be read: every clock stays where it is, and none moves.
    for (const job of jobs) {
      if (job.state?.clockHost !== host) continue;
      wanted.add(job.id);
      const work = await workHostOf(job, deps, new Set([host]), host).catch(() => null);
      if (work?.taskId) taskOf.set(job.id, work.taskId);
    }
    log.cron.warn('clock placement: hosts unknown (config unreadable), clocks stay where they are', { host });
  } else if (host !== '__local__' && hosts.has(host)) {
    for (const job of jobs) {
      if (!clockCandidate(job)) continue;
      // Held by another host: it moves only after that host gives it back.
      if (job.state?.clockHost && job.state.clockHost !== host) continue;
      const work = await workHostOf(job, deps, hosts, host).catch(() => null);
      // The task a transfer moved the work to is watched too: its session starts later.
      if (work?.taskId) watchedTasks.add(work.taskId);
      if (work?.host !== host) continue;
      if (!job.state?.clockHost && refusedHere?.get(job.id) === refusalKeyOf(job, work.taskId)) continue;
      wanted.add(job.id);
      if (work.taskId) taskOf.set(job.id, work.taskId);
    }
  }
  const placed = await service.placeClocks(host, { wanted, handover: capability === 'yes' && hosts !== null, knownHosts: hosts, eligible: clockCandidate });
  // A daemon that has not said it holds clocks gets none: an older one refuses
  // the whole set over a def it cannot read.
  const defs: TriggerDef[] = [];
  if (capability === 'yes') {
    for (const job of placed.owned) {
      // A claude-code run the host may start itself while this Mac is away
      // (clock-host-start-v1): only for a daemon that can, holding the routine template.
      const start = opts.hostStart && job.executor?.type === 'claude-code' && deps.routineStart
        ? await deps.routineStart(job, host).catch(() => null)
        : null;
      const def = clockDefOf(job, taskOf.get(job.id), WALNUT_HOME, start);
      if (def) defs.push(def);
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
      };
      rememberRefused(host, placed.owned, taskOf, refused);
      const back = await service.settleClocks(host, clockReply);
      if (back.length > 0) log.cron.info('clock routines back on the server timer', { host, jobIds: back });
    },
    rejected: async () => {
      await service.revertClocks(host, handed);
    },
  };
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
  if (!clockCandidate(job)) return 'no';
  const config = (job.executor?.config ?? {}) as Record<string, unknown>;
  if (job.executor?.type === 'claude-code') return typeof config.host === 'string' && config.host.trim() === host ? 'yes' : 'no';
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
    void strandedSweep().catch((err) => log.cron.warn('clock placement: stranded sweep failed', { error: err instanceof Error ? err.message : String(err) }));
  }, REPLACE_DEBOUNCE_MS);
  timer.unref?.();
}

async function strandedSweep(): Promise<void> {
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  if (!service) return;
  const back = await takeBackStrandedClocks(service, await service.list({ includeDisabled: true, recompute: false }));
  if (back.length > 0) log.cron.info('clock routines back on the server timer: they left their unreachable host', { jobIds: back });
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
  refusedClocks.clear();
}
