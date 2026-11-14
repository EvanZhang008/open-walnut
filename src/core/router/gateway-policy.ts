import { WALNUT_HOME } from '../../constants.js';
import { readRouterAreas, taskArea, type RouterAreasFile } from './areas.js';
import type { SessionRecord, Task } from '../types.js';

export const ROUTER_AREA_OPS = new Set(['router_context', 'router_route']);
/** No op at all: an area trace that cannot be read, or that names two areas. */
const NO_OPS: ReadonlySet<string> = new Set<string>();

const NOT_FOUND = /^(No task found|Ambiguous ID prefix)/;

export interface GatewayPolicyDeps {
  readAreas(): Promise<RouterAreasFile>;
  session(sid: string): Promise<Pick<SessionRecord, 'profile' | 'taskId' | 'legacyTaskId'> | null>;
  // Undefined only for "no such task": any other failure allows the caller nothing.
  task(id: string): Promise<(Pick<Task, 'id'> & { router_area_id?: string | null; org_role?: string | null }) | undefined>;
  sessionsForTask(taskId: string): Promise<Array<Pick<SessionRecord, 'profile'>>>;
}

const defaultDeps: GatewayPolicyDeps = {
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
const isRouterProfile = (profile: Profile): boolean => profile?.areaRole === 'router';

/**
 * The ops a known session may use, or undefined for an ordinary one. Only a router is held to its
 * two ops (it reads outside content): its own router profile, a router assignment or role of its
 * task or legacy task, or a router profile on one of their sessions. Since 2026-11-14 the work a
 * router hands items to is ordinary work: an older build's area mark or receiver ('work') profile
 * on it is not read. A router trace naming two areas, or a trace that cannot be read, allows nothing.
 */
export async function areaOpsForCaller(callerSid: string, deps: GatewayPolicyDeps = defaultDeps): Promise<ReadonlySet<string> | undefined> {
  if (!callerSid || callerSid === 'external') return undefined;
  const record = await deps.session(callerSid);
  // An unknown id is an outside caller: provenance, not a sandbox.
  if (!record) return undefined;
  const profile = record.profile as Profile;
  const areas = new Set<string>();
  let routerMark = isRouterProfile(profile);
  if (routerMark && areaOf(profile)) areas.add(areaOf(profile));
  try {
    const file = await deps.readAreas();
    for (const id of new Set([record.taskId, record.legacyTaskId].filter((v): v is string => !!v))) {
      const task = await deps.task(id);
      if (task?.org_role === 'router') {
        routerMark = true;
        const mark = typeof task.router_area_id === 'string' ? task.router_area_id.trim() : '';
        if (mark) areas.add(mark);
      }
      const listed = taskArea(file, id)?.id;
      if (listed) { areas.add(listed); routerMark = true; }
      for (const sibling of await deps.sessionsForTask(id)) {
        const p = sibling.profile as Profile;
        if (isRouterProfile(p)) { routerMark = true; if (areaOf(p)) areas.add(areaOf(p)); }
      }
    }
  } catch {
    return NO_OPS;
  }
  if (!routerMark) return undefined;
  if (areas.size > 1) return NO_OPS;
  return ROUTER_AREA_OPS;
}
