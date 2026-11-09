/**
 * A routine run that did not happen is told to whoever owns the routine (cron/run-log.ts decides
 * what was missed). 2026-11-08: the daily org reflection did not run, and nobody knew until a
 * reflection the next day found no task for it.
 *
 * Every few minutes the primary looks at each routine's missed runs and tells, once per missed
 * slot: the routine's owner task (or its lead, when the owner has no session), the way a failing
 * trigger is told (trigger-health.ts), never the user; a routine nobody owns (one the user made)
 * goes on the user's notifications. Either way the Routines page shows it.
 * The notice says how to run the missed one now and how to set it aside.
 */

import { log } from '../../logging/index.js';
import type { CronJob } from '../cron/types.js';
import { missedRuns, routineOwnerTaskId, type MissedRun } from '../cron/run-log.js';

export const MISSED_SWEEP_MS = 5 * 60_000;
const FIRST_SWEEP_MS = 90_000;

/** The slot's time as the routine's own clock reads it. */
export function slotLabel(job: Pick<CronJob, 'schedule'>, slotMs: number): string {
  const tz = job.schedule.kind === 'cron' && job.schedule.tz ? job.schedule.tz : undefined;
  try {
    return new Date(slotMs).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      ...(tz ? { timeZone: tz, timeZoneName: 'short' } : {}),
    });
  } catch {
    return new Date(slotMs).toISOString();
  }
}

/** The owner's notice: what was missed, why, and the two ways on. */
export function missedRunNotice(job: Pick<CronJob, 'id' | 'name' | 'schedule'>, missed: MissedRun[], about: 'owner' | 'lead'): string {
  const whose = about === 'owner' ? 'Your routine' : 'The routine';
  const lines = missed.map((m) => `- ${slotLabel(job, m.slotMs)} (${new Date(m.slotMs).toISOString()}): ${m.reason}`);
  const first = missed[0];
  return [
    `${whose} "${job.name}" (${job.id}) missed ${missed.length === 1 ? 'a run' : `${missed.length} runs`}; nothing ran in ${missed.length === 1 ? 'its place' : 'their place'}:`,
    ...lines,
    `To run it now for that time: walnut tools call api '{"method":"POST","path":"/api/routines/${job.id}/run","body":{"catchUpMs":${first.slotMs}}}'.`,
    `To set it aside (no run): walnut tools call api '{"method":"POST","path":"/api/routines/${job.id}/missed/dismiss","body":{"slotMs":${first.slotMs}}}'.`,
    `Its run history is "runLog" in walnut tools call api '{"method":"GET","path":"/api/routines/${job.id}"}'. The Routines page shows it too.`,
  ].join('\n');
}

type Service = {
  list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]>;
  markMissed(id: string, mark: { told?: number[] }): Promise<CronJob | null>;
};

export interface MissedRunDeps {
  service(): Promise<Service | null>;
  tellTeam(input: { taskId: string; job: CronJob; missed: MissedRun[] }): Promise<boolean>;
  bell(input: { job: CronJob; missed: MissedRun[] }): Promise<void>;
  now(): number;
}

/** One pass: tell each routine's new missed runs. Returns how many routines were told about. */
export async function noticeMissedRunsOnce(deps: MissedRunDeps = defaultDeps()): Promise<number> {
  const service = await deps.service();
  if (!service) return 0;
  const now = deps.now();
  let told = 0;
  for (const job of await service.list({ includeDisabled: false })) {
    const known = new Set(job.state.missedToldMs ?? []);
    const fresh = missedRuns(job, now).filter((m) => !known.has(m.slotMs));
    if (!fresh.length) continue;
    // Recorded first: a notice that fails is not retried every five minutes into a session.
    await service.markMissed(job.id, { told: fresh.map((m) => m.slotMs) });
    const owner = routineOwnerTaskId(job);
    // A routine a session made tells its team, never the user; one nobody owns is the user's own.
    const reached = owner ? await deps.tellTeam({ taskId: owner, job, missed: fresh }) : false;
    if (!owner) await deps.bell({ job, missed: fresh });
    log.cron.warn('routine missed a run', {
      jobId: job.id, jobName: job.name, slots: fresh.map((m) => new Date(m.slotMs).toISOString()),
      reasons: fresh.map((m) => m.reason), told: owner ? (reached ? 'owner' : 'nobody (Routines page only)') : 'notifications',
      ...(owner ? { ownerTaskId: owner } : {}),
    });
    told++;
  }
  return told;
}

function defaultDeps(): MissedRunDeps {
  return {
    async service() {
      const { getCronService } = await import('../../web/routes/cron.js');
      return getCronService();
    },
    async tellTeam({ taskId, job, missed }) {
      const { tellTriggerTeam } = await import('./trigger-health.js');
      const out = await tellTriggerTeam({
        taskId, jobId: job.id, reach: 'team',
        text: (a) => missedRunNotice(job, missed, a.kind === 'owner' ? 'owner' : 'lead'),
      });
      return out.to !== null;
    },
    async bell({ job, missed }) {
      const { addNotification } = await import('../notifications/store.js');
      const first = missed[0];
      await addNotification({
        kind: 'cron', severity: 'warning',
        title: `Routine "${job.name}" missed ${missed.length === 1 ? 'a run' : `${missed.length} runs`}`,
        body: `${slotLabel(job, first.slotMs)}: ${first.reason}. Open Routines to run it now or set it aside.`,
        dedupKey: `routine-missed:${job.id}:${first.slotMs}`,
      });
    },
    now: () => Date.now(),
  };
}

/** The primary's sweep. */
export function startMissedRunSweep(): { stop: () => void } {
  let stopped = false;
  let running = false;
  const run = (): void => {
    if (stopped || running) return;
    running = true;
    void noticeMissedRunsOnce()
      .catch((err) => log.cron.warn('missed-run sweep failed', { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => { running = false; });
  };
  const first = setTimeout(run, FIRST_SWEEP_MS);
  first.unref?.();
  const every = setInterval(run, MISSED_SWEEP_MS);
  every.unref?.();
  return { stop: () => { stopped = true; clearTimeout(first); clearInterval(every); } };
}
