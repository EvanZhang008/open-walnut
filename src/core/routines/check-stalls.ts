/**
 * A trigger whose host is linked and that has not checked for more than two of its periods says
 * so to its owner (2026-11-25, the Operations VP: "a trigger that has not run its check for more
 * than two periods should report it itself, not wait for my clock to notice"). A trigger's checks
 * are reported by its host; while the host's link or this Walnut was down, no report could come,
 * and those that ran then come with the next configure (providers/trigger-unsent-checks.ts): so
 * only a window in which the link was up the whole time and this machine never woke counts.
 * Told once per stall (until a newer check comes), the way a missed run is (missed-runs.ts).
 */
import { log } from '../../logging/index.js';
import type { CronJob } from '../cron/types.js';
import { routineOwnerChain } from '../cron/run-log.js';
import { linkUpThroughout } from '../../providers/host-link-ledger.js';
import { lastHostSignalAt } from '../../providers/daemon-reconnect-cause.js';
import { CHECK_ERROR_BACKOFF_MS, MAX_CONSECUTIVE_CHECK_ERRORS } from '../../providers/trigger-check-core.js';

/** Past two periods, this much more before a stall counts: a check's own time and a late tick. */
export const CHECK_STALL_GRACE_MS = 5 * 60_000;

export interface CheckStall { lastMs: number; overdueMs: number; everyMs: number; host: string }

/** The stall of `job` at `now`, or null: it checked lately, it is not a periodic check, or its host's link was not up throughout. */
export function checkStallOf(job: CronJob, now: number, linkUp: (host: string, from: number, to: number) => boolean): CheckStall | null {
  if (!job.enabled || !job.check || job.schedule.kind !== 'every') return null;
  if (!(job.schedule.everyMs > 0)) return null;
  // A check failing in a row runs on the host's backoff, as the daemon paces it (daemon-trigger-runs.ts triggerCadenceMs).
  const everyMs = (job.state.consecutiveErrors ?? 0) >= MAX_CONSECUTIVE_CHECK_ERRORS
    ? Math.max(job.schedule.everyMs, CHECK_ERROR_BACKOFF_MS) : job.schedule.everyMs;
  const lastMs = job.state.lastCheck?.atMs ?? job.state.expectFromMs ?? job.createdAtMs;
  if (!Number.isFinite(lastMs)) return null;
  const overdueMs = now - lastMs;
  if (overdueMs <= 2 * everyMs + CHECK_STALL_GRACE_MS) return null;
  const host = job.check.host;
  if (!linkUp(host, lastMs, now)) return null;
  return { lastMs, overdueMs, everyMs, host };
}

/** The owner's notice. */
export function checkStallNotice(job: Pick<CronJob, 'id' | 'name'>, stall: CheckStall): string {
  const mins = (ms: number) => Math.round(ms / 60_000);
  return [
    `Your trigger "${job.name}" (${job.id}) has not reported a check for ${mins(stall.overdueMs)} minutes, more than two of its ${mins(stall.everyMs)}-minute periods, `
      + `while its host ${stall.host} stayed linked the whole time. Its last check was at ${new Date(stall.lastMs).toISOString()}.`,
    `Look at its host's trigger log (the daemon's "trigger run" lines for ${job.id}) or run it now: walnut tools call trigger_test '{"id":"${job.id}"}'.`,
  ].join('\n');
}

export interface CheckStallDeps {
  jobs(): Promise<CronJob[]>;
  linkUp(host: string, from: number, to: number): boolean;
  tellTeam(input: { taskId: string; job: CronJob; stall: CheckStall }): Promise<boolean>;
  mainTaskId(): Promise<string | undefined>;
  now(): number;
}

/** Last check time told per trigger: a stall is told once, until a newer check comes. */
const told = new Map<string, number>();

/** One pass: tell each new stall. Returns how many were told. */
export async function noticeCheckStallsOnce(deps: CheckStallDeps = defaultDeps()): Promise<number> {
  const now = deps.now();
  const main = await deps.mainTaskId();
  let n = 0;
  for (const job of await deps.jobs()) {
    const stall = checkStallOf(job, now, deps.linkUp);
    if (!stall || told.get(job.id) === stall.lastMs) continue;
    told.set(job.id, stall.lastMs);
    let reached = false;
    for (const taskId of routineOwnerChain(job, main)) {
      if ((reached = await deps.tellTeam({ taskId, job, stall }))) break;
    }
    log.cron.warn('trigger has not checked for over two periods', {
      jobId: job.id, jobName: job.name, host: stall.host, lastCheck: new Date(stall.lastMs).toISOString(),
      overdueMin: Math.round(stall.overdueMs / 60_000), told: reached ? 'owner' : 'nobody (Routines page and Health only)',
    });
    n++;
  }
  return n;
}

/** Test seam. */
export function resetCheckStallsForTest(): void { told.clear(); }

function defaultDeps(): CheckStallDeps {
  return {
    async jobs() {
      const { isFollower } = await import('../server-role.js');
      // A follower's copy of the routines is not where checks are recorded.
      if (isFollower()) return [];
      const { getCronService } = await import('../../web/routes/cron.js');
      const service = getCronService();
      return service ? service.list({ includeDisabled: false }) : [];
    },
    linkUp: (host, from, to) => {
      // This machine slept or changed network inside the window: its links did not see it all.
      if (lastHostSignalAt() >= from) return false;
      return linkUpThroughout(host, from, to);
    },
    async tellTeam({ taskId, job, stall }) {
      const { tellTriggerTeam } = await import('./trigger-health.js');
      const out = await tellTriggerTeam({ taskId, jobId: job.id, host: stall.host, reach: 'team', text: () => checkStallNotice(job, stall) });
      return out.to !== null;
    },
    async mainTaskId() {
      const { currentMainTaskId } = await import('./routine-owner.js');
      return currentMainTaskId();
    },
    now: () => Date.now(),
  };
}
