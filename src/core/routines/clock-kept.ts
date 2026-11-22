/**
 * A routine of a task kept local (replication/host-private.ts) keeps its clock off a host none of
 * that task's sessions run on: the def a host arms carries the routine's name, its prompt, and for
 * a portable routine a sample of its owner's conversation and rules. Such a clock stays on (or
 * comes back to) the Mac's own timer. The tasks a routine belongs to are the ones its copy kind
 * names (kinds/routines.ts owners: the task it delivers into, its owner, the one it acts for), and
 * for an offline routine the owner whose conversation its start samples (offline-run.ts ownerOf).
 */
import type { CronJob } from '../cron/types.js';

/** The task ids a routine's definition names as its own. */
export function routineTaskIds(job: CronJob): string[] {
  const target = (job.executor?.config as { target?: unknown } | undefined)?.target;
  return [target, job.ownerTaskId, job.checkActsFor]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
}

/**
 * Whether this host leaves the routine's clock out. `keptOff`: host-private.ts keptOffHost for this
 * host (a kept task whose own session runs here is not kept off it). `owner`: an offline routine's
 * owner, when it has one (read only when no id of the definition already decides).
 */
export async function clockKeptOff(
  job: CronJob,
  keptOff: (taskId: string) => boolean,
  owner?: () => Promise<string | null | undefined>,
): Promise<boolean> {
  if (routineTaskIds(job).some((id) => keptOff(id))) return true;
  if (!owner) return false;
  const id = await owner().catch(() => null);
  return !!id && keptOff(id);
}
