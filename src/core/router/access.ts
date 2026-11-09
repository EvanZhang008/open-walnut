import { readRouterAreas, sourceArea, taskArea, activeRouter, RouterAreaError, type RouterAreasFile } from './areas.js';
import type { RouterSource } from './types.js';
import { WALNUT_HOME } from '../../constants.js';

export async function routerAccess(source: RouterSource, callerSid: string | undefined, home = WALNUT_HOME): Promise<RouterAreasFile> {
  const file = await readRouterAreas(home);
  if (source.kind === 'mail' && source.version === undefined) {
    throw new RouterAreaError('area_unassigned', 409, 'This email needs its exact confirmed delivery version.');
  }
  const area = sourceArea(file, source);
  if (!area) throw new RouterAreaError('area_unassigned', 409, 'This item has no confirmed area. No router has read it.');
  if (!callerSid?.trim()) return file;
  const { resolveCaller } = await import('../sessions/session-send-core.js');
  const caller = await resolveCaller(callerSid);
  const taskId = caller.kind === 'session' ? caller.record.taskId : undefined;
  const { isRouterAreaSession } = await import('./session-policy.js');
  if (!taskId || taskArea(file, taskId)?.id !== area.id
    || activeRouter(file, area.id)?.taskId !== taskId
    || caller.kind !== 'session' || !isRouterAreaSession(caller.record, area, 'router')) {
    throw new RouterAreaError('area_forbidden', 403, 'Only this area\'s active router may read or route this item.');
  }
  // The registry names the router; the task itself must still be that live router: its own
  // markers, not paused (an unset flag reads as paused, as a new router starts), not complete.
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => undefined);
  if (!task || task.source !== 'local' || task.org_role !== 'router' || task.router_area_id !== area.id
    || task.router_paused !== false || task.phase === 'COMPLETE') {
    throw new RouterAreaError('area_forbidden', 403, 'Only this area\'s active router may read or route this item.');
  }
  return file;
}
