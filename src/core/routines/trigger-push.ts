/**
 * Compiling the armed trigger set for ONE daemon (`triggers.configure`).
 *
 * A daemon holds one authoritative set per Walnut, including every alias that
 * reaches it: it persists it, arms its own timers from it, and keeps polling while the
 * server restarts. So this is the full set, recomputed from the cron store every time; a
 * daemon that holds the set pushed before gets only what changed (triggers-delta-v1,
 * daemon-connection.ts pushTriggersOnce).
 *
 * Two rules the shape encodes:
 *  - a FIXED key order per def, and defs sorted by id, so the hash is stable
 *    across restarts and key-order differences (JSON.stringify is
 *    insertion-ordered). The hash is what turns "push on every connect and every
 *    routine mutation" into a no-op when nothing changed.
 *  - a disabled job is simply ABSENT. Disabling a routine is the kill switch, so
 *    the next push must actually take it off the daemon's clock.
 *
 * A check runs on its host whoever owns it, but what it delivers to a task kept local
 * (replication/host-private.ts) stays off a host none of that task's sessions run on: the
 * def goes without its `deliver` (the target and the prompt), and the fire waits for the
 * server. A clock routine is placed where its target's session runs, so it keeps its own.
 */

import { WALNUT_HOME } from '../../constants.js';
import { DELIVER_PROMPT_MAX, FIRE_BUDGET_UNLIMITED, clampTimeoutSeconds, triggerPushHash } from '../../providers/trigger-check-core.js';
import type { TriggerDef, TriggerDeliverSpec, TriggersConfigurePayload } from '../../providers/trigger-check-core.js';
import { cloudModeSkipsJob } from '../cron/jobs.js';
import type { CronJob } from '../cron/types.js';
import type { HostClocks } from './clock-placement.js';

/** The routine's own instruction text, whichever executor holds it. */
export function promptOf(job: CronJob): string {
  const config = job.executor?.config ?? {};
  const prompt = (config as { prompt?: unknown }).prompt;
  if (typeof prompt === 'string' && prompt.trim()) return prompt;
  const instructions = (config as { instructions?: unknown }).instructions;
  return typeof instructions === 'string' ? instructions : '';
}

/**
 * What the daemon needs to deliver a fire no server claimed: a `session`
 * routine's target task and prompt, under this Walnut's data dir (the tenant key
 * of the host copy). Any other executor is the server's alone, and so is a
 * prompt too long to carry.
 */
export function deliverSpecOf(job: CronJob, home: string = WALNUT_HOME): TriggerDeliverSpec | undefined {
  if (job.executor?.type !== 'session') return undefined;
  const target = (job.executor.config as { target?: unknown } | undefined)?.target;
  const prompt = promptOf(job);
  if (typeof target !== 'string' || !target.trim() || !prompt.trim() || prompt.length > DELIVER_PROMPT_MAX) return undefined;
  return { home, taskId: target.trim(), prompt };
}

export interface CompiledTriggers {
  payload: TriggersConfigurePayload;
  hash: string;
  /** The daemon accepted this set: settle the clock routines it holds (clock-placement.ts). */
  applied?: (reply: Record<string, unknown>) => Promise<void>;
  /** The daemon refused it: what this set handed over comes back. */
  rejected?: () => Promise<void>;
}

/** One stored job → one wire def. Returns null when the job is not a trigger for this host. */
export function triggerDefOf(job: CronJob, host: string): TriggerDef | null {
  if (!job.check || !job.enabled) return null;
  if ((job.check.host || '__local__') !== host) return null;
  if (job.schedule.kind !== 'every') return null;
  if (cloudModeSkipsJob(job)) return null;
  // An older daemon drops the field (validateTriggerDef keeps known keys only).
  const deliver = deliverSpecOf(job);
  const def: TriggerDef = {
    id: job.id,
    name: job.name,
    everyMs: Math.floor(job.schedule.everyMs),
    check: {
      run: job.check.run,
      ...(job.check.cwd ? { cwd: job.check.cwd } : {}),
      timeoutSeconds: clampTimeoutSeconds(job.check.timeoutSeconds),
    },
    ...(typeof job.check.maxFiresPerDay === 'number'
      ? { limits: { maxFiresPerDay: wireFireCap(job.check.maxFiresPerDay) } }
      : {}),
    ...(deliver ? { deliver } : {}),
  };
  return def;
}

/**
 * A stored 0 means "no limit", which the daemon has no word for (it refuses a
 * cap below 1, and always has), so it goes out as a cap nothing reaches. Not the
 * cadence's own maximum: a Run now, a resume or a daemon restart adds checks, and
 * a once-a-day trigger would then be held for a day after its one fire.
 */
export function wireFireCap(stored: number): number {
  const cap = Math.max(0, Math.floor(stored));
  return cap > 0 ? cap : FIRE_BUDGET_UNLIMITED;
}

/**
 * The set for one daemon: the checks of every host alias in `hosts` (one alias, or all
 * the aliases that reach the same daemon, which keeps one set for all of them), and the
 * clock defs placed there. One def per id, the first kept.
 */
export function compileTriggerDefs(
  jobs: CronJob[], hosts: string | readonly string[], clockDefs: TriggerDef[] = [], keptOff: (taskId: string) => boolean = () => false,
): CompiledTriggers {
  const aliases = typeof hosts === 'string' ? [hosts] : hosts;
  const seen = new Set<string>();
  const triggers = aliases
    .flatMap((host) => jobs.map((job) => triggerDefOf(job, host)))
    .filter((def): def is TriggerDef => def !== null)
    .map((def) => (def.deliver && keptOff(def.deliver.taskId) ? withoutDeliver(def) : def))
    .concat(clockDefs)
    .filter((def) => !seen.has(def.id) && !!seen.add(def.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { payload: { version: 1, triggers }, hash: triggerPushHash(triggers) };
}

function withoutDeliver(def: TriggerDef): TriggerDef {
  const { deliver: _deliver, ...rest } = def;
  return rest;
}

/** Whether a check of the host reached by `aliases` delivers to `taskId` (host-private.ts keptOffHost). */
async function keptOffFor(aliases: readonly string[]): Promise<(taskId: string) => boolean> {
  const { hostPrivacyNow, keptOffHost } = await import('../replication/host-private.js');
  const privacy = await hostPrivacyNow();
  if (privacy.tasks.size === 0) return () => false;
  const [{ sessionRowsForReplica }, { normalizeHostKey }] = await Promise.all([import('../session-tracker.js'), import('../host-slice.js')]);
  const keys = new Set(aliases.map(normalizeHostKey));
  const ownHere = new Set((await sessionRowsForReplica()).filter((s) => !!s.taskId && keys.has(normalizeHostKey(s.host))).map((s) => s.taskId));
  return (taskId) => keptOffHost(taskId, privacy, ownHere);
}

/** `host` first, then the other aliases of its daemon, each once. */
function aliasesOf(host: string, sameDaemon: readonly string[] | undefined): string[] {
  return [host, ...(sameDaemon ?? []).filter((h) => h !== host)].filter((h, i, all) => all.indexOf(h) === i);
}

/**
 * The armed set for a host, or null when the cron engine is not running.
 *
 * null is load-bearing: an empty set would DISARM every trigger on that host,
 * and a connect that lands while the server is still booting must not do that.
 *
 * `sameDaemon`: the aliases that reach this same daemon process (daemon-connection.ts
 * sameDaemonHosts). The daemon keeps one set per Walnut, so the set is all of theirs:
 * pushed under one alias alone, it would disarm the others' (2026-11-15).
 */
export async function compileTriggersForHost(
  host: string,
  opts: { clock?: 'yes' | 'no' | 'unknown'; fresh?: boolean; hostStart?: boolean; sameDaemon?: readonly string[] } = {},
): Promise<CompiledTriggers | null> {
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  if (!service) return null;
  const aliases = aliasesOf(host, opts.sameDaemon);
  // As stored: a recompute here would move a slot that is due right now past the
  // timer about to run it (or past the daemon about to be handed it).
  const jobs = await service.list({ includeDisabled: true, recompute: false });
  // Clock routines whose work runs on this host (clock-routine-v1). Placement
  // writes the handover under the cron lock BEFORE this set goes out.
  // Only the Mac hands clocks out; any other server pushes its checks alone.
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return compileTriggerDefs(jobs, aliases);
  const keptOff = await keptOffFor(aliases);
  const { placeClocksForHost, noteWatchedTasks } = await import('./clock-placement.js');
  noteWatchedTasks(jobs);
  // Each alias's clocks are placed as its own (a clock's holder is the alias), one after
  // another: each placement reads the store after the one before handed its clocks over.
  const placed: HostClocks[] = [];
  for (const alias of aliases) {
    const seen = alias === host ? jobs : await service.list({ includeDisabled: true, recompute: false });
    // A refusal is forgotten only for the alias whose link is new; the daemon of the others did not change.
    placed.push(await placeClocksForHost(service, alias, seen, opts.clock ?? 'unknown', undefined, {
      fresh: opts.fresh === true && alias === host, hostStart: opts.hostStart === true,
    }));
  }
  if (placed.length === 1) {
    return { ...compileTriggerDefs(jobs, aliases, placed[0].defs, keptOff), applied: placed[0].applied, rejected: placed[0].rejected };
  }
  // One reply for the whole set: each alias settles the clocks it holds (settleClocks reads only those).
  const each = async (run: (p: HostClocks) => Promise<void>): Promise<void> => {
    const errors: unknown[] = [];
    for (const p of placed) await run(p).catch((err: unknown) => { errors.push(err); });
    if (errors.length) throw errors[0];
  };
  return {
    ...compileTriggerDefs(jobs, aliases, placed.flatMap((p) => p.defs), keptOff),
    applied: (reply) => each((p) => p.applied(reply)),
    rejected: () => each((p) => p.rejected()),
  };
}
