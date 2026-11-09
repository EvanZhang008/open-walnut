import { WALNUT_HOME } from '../../constants.js';
import { readRouterAreas, taskArea } from './areas.js';
import type { SourceReaderDeps } from './source-reader.js';

export const ROUTER_AREA_OPS = new Set(['router_context', 'router_route']);
export const ROUTER_WORK_OPS = new Set(['router_item', 'router_work']);
/** No op at all: an area trace that cannot be read, or that names two areas. */
const NO_OPS: ReadonlySet<string> = new Set<string>();

const NOT_FOUND = /^(No task found|Ambiguous ID prefix)/;

// The same lookups source-reader.ts judges reads with, so the tool belt and the reader see one caller.
const defaultDeps: SourceReaderDeps = {
  readAreas: () => readRouterAreas(WALNUT_HOME),
  async session(sid) {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    return getSessionByClaudeId(sid);
  },
  async task(id) {
    const { getTask } = await import('../task-manager.js');
    try {
      const task = await getTask(id);
      return task.id === id ? task : undefined;
    } catch (error) {
      if (error instanceof Error && NOT_FOUND.test(error.message)) return undefined;
      throw error;
    }
  },
  async sessionsForTask(taskId) {
    const { getSessionsForTask } = await import('../session-tracker.js');
    return getSessionsForTask(taskId);
  },
};

type Profile = { areaId?: unknown; areaRole?: unknown } | undefined;
const areaOf = (profile: Profile): string => (typeof profile?.areaId === 'string' ? profile.areaId.trim() : '');
const roleOf = (profile: Profile): 'router' | 'work' | undefined =>
  profile?.areaRole === 'router' || profile?.areaRole === 'work' ? profile.areaRole : undefined;

/**
 * The ops a known session may use, or undefined for an ordinary one (no area anywhere). Every area
 * trace counts, as the reader counts it: the record's profile, the marks, router assignments and
 * registry rows of its task and legacy task, and every profile those tasks' sessions hold. A
 * router task with no area is still held to the router's two ops. A trace naming two areas, or one
 * that cannot be read (registry, task), allows nothing. A classification made after this read is
 * seen on the next call, not this one.
 */
export async function areaOpsForCaller(callerSid: string, deps: SourceReaderDeps = defaultDeps): Promise<ReadonlySet<string> | undefined> {
  if (!callerSid || callerSid === 'external') return undefined;
  const record = await deps.session(callerSid);
  // An unknown id is an outside caller: provenance, not a sandbox.
  if (!record) return undefined;
  const profile = record.profile as Profile;
  const areas = new Set<string>();
  let routerMark = false;
  try {
    const file = await deps.readAreas();
    if (areaOf(profile)) areas.add(areaOf(profile));
    for (const id of new Set([record.taskId, record.legacyTaskId].filter((v): v is string => !!v))) {
      const task = await deps.task(id);
      const mark = typeof task?.router_area_id === 'string' ? task.router_area_id.trim() : '';
      if (mark) areas.add(mark);
      if (task?.org_role === 'router') routerMark = true;
      const listed = taskArea(file, id)?.id;
      if (listed) areas.add(listed);
      for (const r of file.routers) if (r.taskId === id) { areas.add(r.areaId); routerMark = true; }
      for (const sibling of await deps.sessionsForTask(id)) {
        const p = sibling.profile as Profile;
        if (areaOf(p)) areas.add(areaOf(p));
        if (roleOf(p) === 'router') routerMark = true;
      }
    }
  } catch {
    return NO_OPS;
  }
  const role = roleOf(profile);
  if (areas.size === 0 && !routerMark && !role) return undefined;
  if (areas.size > 1) return NO_OPS;
  const asRouter = role ? role === 'router' : routerMark;
  return asRouter ? ROUTER_AREA_OPS : ROUTER_WORK_OPS;
}
