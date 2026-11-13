/**
 * Which task, and so which project, a routine belongs to: the Routines page groups
 * routines by it (global first, then one group per project), on the web, the Mac
 * app and the phone alike, so the rule lives here, once, and rides every routine
 * the routes answer as `owner`.
 *
 * A routine belongs to the task it delivers into: the `session` executor's
 * `config.target` (every trigger and clock routine a task arms). A task moved to
 * another host leaves `transferred_to`, which is followed once, as delivery does
 * (clock-placement.ts). Everything else (a Claude Code routine that files a new
 * task per run, the Personal AI's) belongs to no task and is global, and so is a
 * routine whose task is in the Inbox (`project: ''`) or no longer exists.
 *
 * Additive on the wire: an older client ignores `owner`, and a box that cannot read
 * its task store answers the jobs as they were.
 */
import { log } from '../../logging/index.js';

export interface RoutineOwner {
  taskId: string;
  title: string;
  /** '' = the Inbox: shown with the global routines. */
  project: string;
}

type OwnedJob = { executor?: { type?: unknown; config?: unknown } | null; owner?: RoutineOwner };

/** The task a routine delivers into, or null for one that files its own work. */
export function routineTargetTaskId(job: OwnedJob): string | null {
  const executor = job.executor;
  if (!executor || executor.type !== 'session') return null;
  const target = (executor.config as { target?: unknown } | null | undefined)?.target;
  return typeof target === 'string' && target.trim() ? target.trim() : null;
}

type TaskLite = { id: string; title?: string; project?: string; transferred_to?: string };

/** Seam for tests: the batch lookup of the box's own task store. */
export type TaskLookup = (ids: string[]) => Promise<TaskLite[]>;

const defaultLookup: TaskLookup = async (ids) => {
  const { listTasksByIds } = await import('../task-manager.js');
  return listTasksByIds(ids);
};

/** The jobs, each with its `owner` when its task is known. Never throws. */
export async function withRoutineOwners<T extends OwnedJob>(jobs: readonly T[], lookup: TaskLookup = defaultLookup): Promise<T[]> {
  const ids = [...new Set(jobs.map(routineTargetTaskId).filter((id): id is string => !!id))];
  if (ids.length === 0) return [...jobs];
  try {
    const byId = new Map((await lookup(ids)).map((t) => [t.id, t]));
    const moved = [...new Set([...byId.values()].map((t) => t.transferred_to).filter((id): id is string => !!id && !byId.has(id)))];
    if (moved.length) for (const t of await lookup(moved)) byId.set(t.id, t);
    return jobs.map((job) => {
      const id = routineTargetTaskId(job);
      let task = id ? byId.get(id) : undefined;
      if (task?.transferred_to && byId.has(task.transferred_to)) task = byId.get(task.transferred_to);
      if (!task) return job;
      return { ...job, owner: { taskId: task.id, title: task.title ?? '', project: task.project ?? '' } };
    });
  } catch (err) {
    log.web.warn('routine owners unavailable', { error: err instanceof Error ? err.message : String(err) });
    return [...jobs];
  }
}

/** One job, as the detail and write routes answer it. */
export async function withRoutineOwner<T extends OwnedJob>(job: T, lookup?: TaskLookup): Promise<T> {
  return (await withRoutineOwners([job], lookup))[0] ?? job;
}

/**
 * The org's Main, the last task told about a routine's missed run (cron/run-log.ts
 * routineOwnerChain): the routine's owner, else the task it delivers into, else Main.
 *
 * 2026-11-10, Walnut VP: the org reflection's and Inbox Triage's missed runs went to the user's
 * notifications because neither had an owner. Main is read at every sweep, never stored on the
 * routine, so a routine made before owners existed, or one made with none, reaches Main without a
 * migration, and a Main that changes is the one told.
 */

/** The org's Main task now, never made here: a Walnut with no org has none. */
export async function currentMainTaskId(): Promise<string | undefined> {
  try {
    const [{ orgTasks }, { pickMain }] = await Promise.all([import('../org/org-store.js'), import('../org/org-tree.js')]);
    return pickMain(await orgTasks())?.id;
  } catch {
    return undefined;
  }
}
