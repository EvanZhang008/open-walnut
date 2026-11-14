import { taskIdForKey } from '../task-create-idempotency.js';
import { WALNUT_HOME } from '../../constants.js';
import { withOrgLock, OrgError, orgTasks } from '../org/org-store.js';
import { readRouterAreas, updateRouterAreas, normalizeRouterAreas, taskArea, ensureAreasDataVersion, type RouterArea, type RouterAreasFile } from './areas.js';
import { assertIsolatedHistory } from './history-isolation.js';
import type { Task } from '../types.js';

export interface RouterNodeInput {
  name: string;
  areaId: string;
  areaName: string;
  host: string;
  links: string[];
  sources: RouterArea['sources'];
  taskId?: string;
}

export interface RouterNodeResult {
  task: Task;
  /** False when setup found this area's router already configured and changed nothing. */
  created: boolean;
}

export interface RouterNodePatch {
  name?: string;
  links?: string[];
  paused?: boolean;
  /** The folders or labels it watches (names, or the role "inbox"); [] goes back to the plugin's default. */
  folders?: string[];
}

const NAME_MAX = 60;

export function routerName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > NAME_MAX) throw new OrgError('bad_name', 400, 'A router name is 1 to 60 characters.');
  return name;
}

/** Links name open VPs only. A link is a collaboration preference, never ownership or access. */
export async function openLeadLinks(raw: string[]): Promise<string[]> {
  const links = [...new Set(raw)];
  const all = await orgTasks();
  if (links.some((id) => !all.some((task) => task.id === id && task.org_role === 'lead' && task.phase !== 'COMPLETE'))) {
    throw new OrgError('bad_router_links', 400, 'Link existing open VPs. A link is collaboration, not ownership or data access.');
  }
  return links;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((one) => right.has(one));
}

function sourceKeys(sources: RouterArea['sources']): string[] {
  return sources.map((source) => JSON.stringify([source.kind, source.account]));
}

/** The areas write is compare-and-set against the snapshot every check above it read. */
async function writeAreas(file: RouterAreasFile, next: RouterAreasFile): Promise<void> {
  await updateRouterAreas(WALNUT_HOME, (current) => {
    if (JSON.stringify(current) !== JSON.stringify(file)) {
      throw new OrgError('router_configuration_changed', 409, 'Router setup changed concurrently. Read the current configuration and retry.');
    }
    return next;
  });
}

/** The router's wake routine follows its task; a failure is an API error, never a quiet success. */
async function reconcileWake(task: Task, state: string): Promise<void> {
  const { configureRouterWake } = await import('./wake.js');
  try {
    await configureRouterWake(task);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OrgError('router_wake_failed', 503, `${state} Its wake routine could not be updated (${reason}). Retry the edit.`);
  }
}

async function announce(task: Task, created: boolean, source: string): Promise<void> {
  const { bus, EventNames } = await import('../event-bus.js');
  bus.emit(created ? EventNames.TASK_CREATED : EventNames.TASK_UPDATED, { task }, ['web-ui'], { source });
}

/**
 * Create (or finish setting up) the one router of an area. Order: every check and the
 * full areas validation run before any write; then the task's scope mark closes ordinary
 * session registration before the areas file is saved (compare-and-set). An interrupted
 * setup stays closed to starts, and the deterministic task id lets a retry finish it.
 */
export async function createRouterNode(input: RouterNodeInput): Promise<RouterNodeResult> {
  const name = routerName(input.name);
  // Shape of the area itself (id slug, name, host, sources) before anything is read or written.
  normalizeRouterAreas({ version: 1, routers: [], items: [],
    areas: [{ id: input.areaId, name: input.areaName, host: input.host, taskIds: [], sources: input.sources }] });
  return withOrgLock(async () => {
    const { addTask, getTask, updateTaskRaw, TaskIdTakenError } = await import('../task-manager.js');
    const links = await openLeadLinks(input.links);
    const file = await readRouterAreas(WALNUT_HOME);
    const same = file.routers.find((router) => router.areaId === input.areaId);
    if (input.taskId && same && same.taskId !== input.taskId) {
      throw new OrgError('router_exists', 409, 'This area already has a router. Open it rather than creating another.');
    }
    const taskId = input.taskId || same?.taskId || taskIdForKey(`router-area:${input.areaId}`);
    const found = await getTask(taskId).catch((error) => {
      if (error instanceof Error && error.message.includes('No task found matching')) return null;
      throw error;
    });
    const prior = found?.id === taskId ? found : null;
    if (input.taskId && !prior) throw new OrgError('router_task_missing', 404, 'The task to convert does not exist.');
    if (prior && prior.parent_task_id) throw new OrgError('router_has_leader', 409, 'Release this task from its leader before converting it to an independent router.');
    if (prior && prior.org_role && prior.org_role !== 'router') throw new OrgError('not_router', 409, 'A CEO or VP cannot become a router.');
    if (prior && prior.phase === 'COMPLETE') throw new OrgError('router_complete', 409, 'This router is complete. Reopen it explicitly before configuring it.');
    if (prior && prior.source !== 'local') throw new OrgError('router_not_local', 409, 'Make this task local before converting it to a router.');
    const owner = taskArea(file, taskId);
    if ((owner && owner.id !== input.areaId)
      || file.routers.some((router) => router.taskId === taskId && router.areaId !== input.areaId)
      || (prior?.router_area_id && prior.router_area_id !== input.areaId)) {
      throw new OrgError('router_other_area', 409, 'This task already belongs to another area. Areas never move through setup.');
    }
    const area = file.areas.find((one) => one.id === input.areaId);
    // Reuse keeps the area's scope. Empty sources mean "keep what it has"; a different
    // explicit set, or another host, is a reconfiguration setup never does silently.
    if (area && (area.host !== input.host
      || (input.sources.length > 0 && !sameSet(sourceKeys(area.sources), sourceKeys(input.sources))))) {
      throw new OrgError('router_area_changed', 409, 'The existing area has a different host or source set. Edit it explicitly, not through setup.');
    }
    // Both stores agree; a marked task with no assignment still needs setup to finish.
    if (same && prior?.org_role === 'router' && prior.router_area_id === input.areaId) {
      if ((prior.org_name ?? prior.title) !== name || !sameSet(prior.router_links ?? [], links)) {
        throw new OrgError('router_setup_differs', 409, 'This area already has its router with another name or other VP links. Edit it with PATCH /org/routers/:id.');
      }
      await ensureAreasDataVersion(WALNUT_HOME);
      await reconcileWake(prior, prior.router_paused === false ? 'The router is unchanged.' : 'The router is unchanged and paused.');
      return { task: prior, created: false };
    }
    // An existing task converts only with no conversation, or with every one already in this
    // area's router profile: starts and wakes refuse any other, so it would be stuck for good.
    const scope = { id: input.areaId, host: input.host };
    if (prior) await assertIsolatedHistory(prior, scope);
    const next = normalizeRouterAreas({
      ...file,
      areas: area ? file.areas.map((one) => one.id === area.id ? { ...one, taskIds: [...new Set([...one.taskIds, taskId])] } : one)
        : [...file.areas, { id: input.areaId, name: input.areaName, host: input.host, taskIds: [taskId], sources: input.sources }],
      routers: same ? file.routers : [...file.routers, { taskId, areaId: input.areaId, paused: true }],
    });
    if (!prior) {
      try {
        await addTask({ title: name, project: '', source: 'local', org_role: 'router', router_area_id: input.areaId, explicitId: taskId });
      } catch (error) {
        if (!(error instanceof TaskIdTakenError)) throw error;
      }
    }
    // The final preflight helps diagnostics; the synchronous row guard closes the registration race.
    await assertIsolatedHistory(await getTask(taskId), scope);
    await updateTaskRaw(taskId, {
      org_role: 'router', org_name: name, router_area_id: input.areaId, router_links: links,
      router_paused: same?.paused ?? true,
    }, {
      source: 'router-setup', emitEvent: false,
      // Re-checked under the task lock: a task that gained a leader or a role meanwhile is not converted.
      shouldUpdate: (current) => !current.parent_task_id && (!current.org_role || current.org_role === 'router')
        && current.phase !== 'COMPLETE' && current.source === 'local',
    });
    const task = await getTask(taskId);
    if (task.org_role !== 'router' || task.router_area_id !== input.areaId) {
      throw new OrgError('router_task_changed', 409, 'The task changed during router setup. Read it and retry setup.');
    }
    if (JSON.stringify(next) !== JSON.stringify(file)) await writeAreas(file, next);
    await announce(task, !prior, 'router-setup');
    await reconcileWake(task, task.router_paused === false ? 'The router is set up.' : 'The router is set up and paused.');
    return { task, created: true };
  });
}

/**
 * Edit a router's name, VP links, watched folders or pause. Pausing changes only this router's own
 * assignment and its task's router_paused: no area, item or task moves, and nothing is
 * started or delivered. A pause turns the assignment off first and a resume marks the
 * task first, so an interrupted edit always leaves the router paused where it counts.
 */
export async function updateRouterNode(taskId: string, patch: RouterNodePatch, opts?: { expectedPaused?: boolean }): Promise<Task> {
  const name = patch.name === undefined ? undefined : routerName(patch.name);
  return withOrgLock(async () => {
    const { getTask, updateTaskRaw } = await import('../task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    if (!task || task.id !== taskId) throw new OrgError('router_not_found', 404, 'No task has this exact id.');
    if (task.org_role !== 'router') throw new OrgError('not_router', 409, 'This task is not a router. Main, VPs and other tasks are not edited here.');
    if (task.phase === 'COMPLETE') throw new OrgError('router_complete', 409, 'This router is complete. Reopen it explicitly before configuring it.');
    const file = await readRouterAreas(WALNUT_HOME);
    const assignment = file.routers.find((router) => router.taskId === taskId);
    if (!assignment || assignment.areaId !== task.router_area_id) {
      throw new OrgError('router_unassigned', 409, 'This router has no area assignment. Finish its setup first.');
    }
    if (opts?.expectedPaused !== undefined && (assignment.paused !== opts.expectedPaused || (task.router_paused !== false) !== opts.expectedPaused)) {
      throw new OrgError('router_task_changed', 409, 'The router pause changed elsewhere. Read it before changing it.');
    }
    if (patch.folders !== undefined) {
      // Its own filter (2026-11-14, the user: "each router can define its own filters"): only the
      // area's folder list changes; the wake reads it at the next arrival.
      await updateRouterAreas(WALNUT_HOME, (current) => {
        const area = current.areas.find((one) => one.id === assignment.areaId);
        if (!area) throw new OrgError('router_unassigned', 409, 'This router has no area assignment. Finish its setup first.');
        const folders = [...new Set(patch.folders!.map((one) => one.trim()).filter(Boolean))];
        if (folders.length) area.folders = folders;
        else delete area.folders;
        return current;
      }).catch((error: unknown) => {
        if (error instanceof OrgError) throw error;
        throw new OrgError('bad_folders', 400, error instanceof Error ? error.message : String(error));
      });
    }
    const links = patch.links === undefined ? undefined : await openLeadLinks(patch.links);
    const fields: Partial<Task> = {};
    if (name !== undefined && name !== task.org_name) fields.org_name = name;
    if (links !== undefined && !sameSet(links, task.router_links ?? [])) fields.router_links = links;
    const paused = patch.paused;
    if (paused !== undefined && paused !== (task.router_paused !== false)) fields.router_paused = paused;
    const areaChange = paused !== undefined && paused !== assignment.paused;
    // Validated in full (one active router per area) before either store is written.
    const next = areaChange
      ? normalizeRouterAreas({ ...file, routers: file.routers.map((router) => router.taskId === taskId ? { ...router, paused } : router) })
      : file;
    if (!areaChange && Object.keys(fields).length === 0) {
      await reconcileWake(task, 'The router is unchanged.');
      return task;
    }
    // A resume arms the wake first: if that fails nothing is written and the router stays paused.
    if (paused === false && (assignment.paused || task.router_paused !== false)) {
      await reconcileWake({ ...task, router_paused: false }, 'The router is still paused.');
    }
    const writeTask = async (values: Partial<Task>) => {
      if (Object.keys(values).length === 0) return;
      await updateTaskRaw(taskId, values, { source: 'router-edit', emitEvent: false,
        shouldUpdate: (current) => current.org_role === 'router' && current.phase !== 'COMPLETE' });
    };
    if (areaChange && paused) {
      await writeAreas(file, next);
      await writeTask(fields);
    } else if (areaChange) {
      await writeTask(fields);
      try {
        await writeAreas(file, next);
      } catch (error) {
        const revert: Partial<Task> = { router_paused: true };
        if (fields.org_name !== undefined && task.org_name !== undefined) revert.org_name = task.org_name;
        if (fields.router_links !== undefined) revert.router_links = task.router_links ?? [];
        await writeTask(revert).catch(() => undefined);
        throw error;
      }
    } else {
      await writeTask(fields);
    }
    const updated = await getTask(taskId);
    if (paused !== undefined && updated.router_paused !== paused) {
      throw new OrgError('router_task_changed', 409, 'The router changed during the pause update. Read it and retry.');
    }
    if (updated.org_role !== 'router') throw new OrgError('router_task_changed', 409, 'The task changed during the router edit. Read it and retry.');
    await announce(updated, false, 'router-edit');
    await reconcileWake(updated, updated.router_paused === false ? 'The router edit is saved.' : 'The router is paused.');
    return updated;
  });
}
