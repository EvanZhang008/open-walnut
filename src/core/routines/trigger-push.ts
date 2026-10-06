/**
 * Compiling the armed trigger set for ONE host (`triggers.configure`).
 *
 * The daemon on a host holds the authoritative set for that host and nothing
 * else: it persists it, arms its own timers from it, and keeps polling while the
 * server restarts. So this is a full replacement, not a delta, and it is
 * recomputed from the cron store every time.
 *
 * Two rules the shape encodes:
 *  - a FIXED key order per def, and defs sorted by id, so the hash is stable
 *    across restarts and key-order differences (JSON.stringify is
 *    insertion-ordered). The hash is what turns "push on every connect and every
 *    routine mutation" into a no-op when nothing changed.
 *  - a disabled job is simply ABSENT. Disabling a routine is the kill switch, so
 *    the next push must actually take it off the daemon's clock.
 */

import { createHash } from 'node:crypto';
import { WALNUT_HOME } from '../../constants.js';
import { DELIVER_PROMPT_MAX, FIRE_BUDGET_UNLIMITED, clampTimeoutSeconds } from '../../providers/trigger-check-core.js';
import type { TriggerDef, TriggerDeliverSpec, TriggersConfigurePayload } from '../../providers/trigger-check-core.js';
import { cloudModeSkipsJob } from '../cron/jobs.js';
import type { CronJob } from '../cron/types.js';

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

export function compileTriggerDefs(jobs: CronJob[], host: string): CompiledTriggers {
  const triggers = jobs
    .map((job) => triggerDefOf(job, host))
    .filter((def): def is TriggerDef => def !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const hash = createHash('sha256').update(JSON.stringify(triggers)).digest('hex').slice(0, 16);
  return { payload: { version: 1, triggers }, hash };
}

/**
 * The armed set for a host, or null when the cron engine is not running.
 *
 * null is load-bearing: an empty set would DISARM every trigger on that host,
 * and a connect that lands while the server is still booting must not do that.
 */
export async function compileTriggersForHost(host: string): Promise<CompiledTriggers | null> {
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  if (!service) return null;
  const jobs = await service.list({ includeDisabled: true });
  return compileTriggerDefs(jobs, host);
}
