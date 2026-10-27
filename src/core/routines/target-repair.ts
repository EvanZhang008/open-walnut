/**
 * One pass at boot over the stored routines: a `session` routine's target must
 * be a task (2026-10-27: routines kept running in a session that no longer had
 * a task, see main-target.ts). A target that names a session instead is
 * repaired, not guessed at:
 *
 *   - the session has a task, or had one (legacyTaskId) → that task;
 *   - it is the home chat's lane session (the old main agent) → the Main task;
 *   - it is any other session with no task → the routine is switched off, with
 *     the reason on its card, since nothing can say which task it was for.
 *
 * A target that is neither a task nor a session is left alone: delivery already
 * refuses it with "target task … is gone".
 */

import type { CronJob } from '../cron/types.js';
import type { SessionRecord } from '../types.js';
import { log } from '../../logging/index.js';

export type TargetRepair = { id: string; from: string; retarget?: string; disable?: string };

export interface TargetRepairDeps {
  isTask(id: string): Promise<boolean>;
  session(id: string): Promise<Pick<SessionRecord, 'taskId' | 'legacyTaskId' | 'lane'> | null>;
  mainTaskId(): Promise<string>;
}

/** The repairs `jobs` need, decided from the task and session stores. */
export async function planTargetRepairs(jobs: CronJob[], deps: TargetRepairDeps): Promise<TargetRepair[]> {
  const out: TargetRepair[] = [];
  for (const job of jobs) {
    if (job.executor?.type !== 'session') continue;
    const target = (job.executor.config as { target?: unknown }).target;
    if (typeof target !== 'string' || !target) continue;
    if (await deps.isTask(target)) continue;
    const rec = await deps.session(target);
    if (!rec) continue;
    const owner = rec.taskId || rec.legacyTaskId;
    if (owner && await deps.isTask(owner)) {
      out.push({ id: job.id, from: target, retarget: owner });
    } else if (isHomeChatLane(rec.lane)) {
      out.push({ id: job.id, from: target, retarget: await deps.mainTaskId() });
    } else {
      out.push({
        id: job.id, from: target,
        disable: `Switched off: its target ${target} is a session with no task, and a routine only delivers to a task. Edit it to name the task it is for, then switch it on.`,
      });
    }
  }
  return out;
}

/** The Personal AI's own chat lane (`chat:general:<conversation>`), where the main agent used to live. */
function isHomeChatLane(lane: string | undefined): boolean {
  return typeof lane === 'string' && lane.startsWith('chat:general:');
}

/** Boot entry: plan against the real stores and apply through the cron service. */
export async function repairRoutineTargets(): Promise<string[]> {
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  if (!service) return [];
  const { getTask } = await import('../task-manager.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const repairs = await planTargetRepairs(await service.list({ includeDisabled: true }), {
    isTask: async (id) => !!(await getTask(id).catch(() => null)),
    session: async (id) => await getSessionByClaudeId(id).catch(() => null),
    mainTaskId: async () => (await (await import('../org/org-store.js')).ensureMainTask()).id,
  });
  const done = await service.applyTargetRepairs(repairs);
  if (done.length > 0) {
    log.cron.info('routine targets repaired', { repairs: repairs.filter((r) => done.includes(r.id)) });
  }
  return done;
}
