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
import { clampTimeoutSeconds } from '../../providers/trigger-check-core.js';
import type { TriggerDef, TriggersConfigurePayload } from '../../providers/trigger-check-core.js';
import { cloudModeSkipsJob } from '../cron/jobs.js';
import type { CronJob } from '../cron/types.js';

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
      ? { limits: { maxFiresPerDay: Math.max(0, Math.floor(job.check.maxFiresPerDay)) } }
      : {}),
  };
  return def;
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
