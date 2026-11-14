/**
 * One-time move to the simple mail flow (2026-11-14, the user: "mailbox goes straight to the
 * router ... it goes directly to the right person and gives them the original"). Older builds
 * isolated the work a router made (area marks on tasks, receiver session profiles, area
 * membership, person-confirmed restricted items and rules). Now only a router runs isolated, so:
 *
 * - every non-router task leaves its area (registry membership and its `router_area_id` mark);
 * - every receiver ('work') session profile is dropped, so the task resumes with its full tools;
 * - restricted items become open items of the same area, and rule bindings are dropped.
 *
 * Nothing is lost: every changed value is written first to `router/simplify-backups.json`, and
 * `restoreRouterSimplify` puts it back (for a rollback to an older build). Runs at every leader
 * boot and changes nothing once nothing is left to move.
 */
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { readRouterAreas, updateRouterAreas, type RouterAreaItem, type RouterAreasFile, type RouterRuleBinding } from './areas.js';
import type { SessionProfile, Task } from '../types.js';

export interface RouterSimplifyRun {
  at: string;
  /** Non-router task ids each area listed. */
  members: Array<{ areaId: string; taskIds: string[] }>;
  /** Restricted items, as they were. */
  items: RouterAreaItem[];
  ruleBindings: RouterRuleBinding[];
  /** Area marks on non-router tasks. */
  marks: Array<{ taskId: string; areaId: string }>;
  /** Receiver session profiles. */
  profiles: Array<{ sessionId: string; profile: SessionProfile }>;
  /** Set once restoreRouterSimplify put this run back. */
  restoredAt?: string;
}

export interface RouterSimplifyDeps {
  home?: string;
  listTasks?: () => Promise<Array<Pick<Task, 'id' | 'org_role' | 'router_area_id'>>>;
  clearMark?: (taskId: string, areaId: string) => Promise<void>;
  setMark?: (taskId: string, areaId: string) => Promise<void>;
  listProfiles?: () => Promise<Array<{ sessionId: string; profile?: SessionProfile }>>;
  setProfile?: (sessionId: string, profile: SessionProfile | undefined) => Promise<void>;
  now?: () => Date;
  /** Cancels one approval nobody can act on any more. */
  cancelApproval?: (approvalId: string, reason: string) => Promise<void>;
}

export const ROUTER_SIMPLIFY_BACKUPS = 'simplify-backups.json';

export function routerSimplifyBackupsPath(home: string): string {
  return path.join(path.resolve(home), 'router', ROUTER_SIMPLIFY_BACKUPS);
}

function defaults(deps: RouterSimplifyDeps): Required<RouterSimplifyDeps> {
  return {
    home: deps.home ?? WALNUT_HOME,
    listTasks: deps.listTasks ?? (async () => (await import('../task-manager.js')).listTasks({})),
    clearMark: deps.clearMark ?? (async (taskId, areaId) => {
      const { updateTaskRaw } = await import('../task-manager.js');
      // null is the raw path's explicit-clear marker; a task that changed meanwhile keeps what it has.
      await updateTaskRaw(taskId, (current) => current.router_area_id === areaId && current.org_role !== 'router'
        ? { router_area_id: null as unknown as undefined } : null, { source: 'router-simplify', emitEvent: false });
    }),
    setMark: deps.setMark ?? (async (taskId, areaId) => {
      const { updateTaskRaw } = await import('../task-manager.js');
      await updateTaskRaw(taskId, (current) => current.router_area_id ? null : { router_area_id: areaId }, { source: 'router-simplify-restore', emitEvent: false });
    }),
    listProfiles: deps.listProfiles ?? (async () => {
      const { listSessions } = await import('../session-tracker.js');
      return (await listSessions()).map((record) => ({ sessionId: record.claudeSessionId, profile: record.profile }));
    }),
    setProfile: deps.setProfile ?? (async (sessionId, profile) => {
      const { updateSessionRecord } = await import('../session-tracker.js');
      await updateSessionRecord(sessionId, { profile });
    }),
    now: deps.now ?? (() => new Date()),
    cancelApproval: deps.cancelApproval ?? (async (approvalId, reason) => {
      await (await import('../approvals/store.js')).cancelInternal(approvalId, reason);
    }),
  };
}

async function readRuns(home: string): Promise<RouterSimplifyRun[]> {
  const saved = await readJsonFile<unknown>(routerSimplifyBackupsPath(home), [], { readErrors: 'throw' });
  return Array.isArray(saved) ? saved as RouterSimplifyRun[] : [];
}

const routerIdsOf = (file: RouterAreasFile, tasks: ReadonlyArray<Pick<Task, 'id' | 'org_role'>>) =>
  new Set([...file.routers.map((one) => one.taskId), ...tasks.filter((task) => task.org_role === 'router').map((task) => task.id)]);

const sourceKey = (item: RouterAreaItem) => JSON.stringify([item.source.kind, item.source.account, item.source.message, item.source.version ?? '']);

/** What is left to move in one registry state; pure, so the run computes it again under the areas lock. */
function planOf(
  file: RouterAreasFile, tasks: ReadonlyArray<Pick<Task, 'id' | 'org_role' | 'router_area_id'>>,
  profiles: ReadonlyArray<{ sessionId: string; profile?: SessionProfile }>,
): Omit<RouterSimplifyRun, 'at'> {
  const routers = routerIdsOf(file, tasks);
  return {
    members: file.areas.map((area) => ({ areaId: area.id, taskIds: area.taskIds.filter((id) => !routers.has(id)) }))
      .filter((one) => one.taskIds.length > 0),
    items: file.items,
    ruleBindings: file.ruleBindings ?? [],
    marks: tasks.filter((task) => !routers.has(task.id) && typeof task.router_area_id === 'string' && task.router_area_id.trim())
      .map((task) => ({ taskId: task.id, areaId: task.router_area_id! })),
    profiles: profiles.filter((one): one is { sessionId: string; profile: SessionProfile } => one.profile?.areaRole === 'work'),
  };
}

/** What is left to move; empty lists once the store is simple. */
export async function planRouterSimplify(deps: RouterSimplifyDeps = {}): Promise<Omit<RouterSimplifyRun, 'at'>> {
  const d = defaults(deps);
  const [file, tasks, profiles] = await Promise.all([readRouterAreas(d.home), d.listTasks(), d.listProfiles()]);
  return planOf(file, tasks, profiles);
}

const isEmpty = (plan: Omit<RouterSimplifyRun, 'at'>) =>
  !plan.members.length && !plan.items.length && !plan.ruleBindings.length && !plan.marks.length && !plan.profiles.length;

/**
 * Moves the store to the simple flow. The plan is made again under the areas lock, and its backup
 * lands before the registry changes, so what is backed up is exactly what is moved. Returns the
 * run, or null when nothing was left.
 */
export async function runRouterSimplify(deps: RouterSimplifyDeps = {}): Promise<RouterSimplifyRun | null> {
  const d = defaults(deps);
  await retireHandoffApprovals(d);
  const [tasks, profiles] = await Promise.all([d.listTasks(), d.listProfiles()]);
  // Most boots: nothing left, and the registry is not written at all.
  if (isEmpty(planOf(await readRouterAreas(d.home), tasks, profiles))) return null;
  let run: RouterSimplifyRun | null = null;
  await updateRouterAreas(d.home, async (current) => {
    const plan = planOf(current, tasks, profiles);
    if (isEmpty(plan)) return current;
    run = { at: d.now().toISOString(), ...plan };
    await writeJsonFile(routerSimplifyBackupsPath(d.home), [...await readRuns(d.home), run]);
    // From here on no start or read treats that work as area work.
    const routers = routerIdsOf(current, tasks);
    for (const area of current.areas) area.taskIds = area.taskIds.filter((id) => routers.has(id));
    const open = [...(current.openItems ?? [])];
    const listed = new Set(open.map(sourceKey));
    for (const item of current.items) if (!listed.has(sourceKey(item))) open.push(item);
    current.items = [];
    if (open.length) current.openItems = open;
    delete current.ruleBindings;
    return current;
  });
  const done = run as RouterSimplifyRun | null;
  if (!done) return null;
  for (const mark of done.marks) await d.clearMark(mark.taskId, mark.areaId);
  for (const one of done.profiles) await d.setProfile(one.sessionId, undefined);
  return done;
}

/**
 * Puts back what the runs moved, newest first, for a rollback to an older build: stop the server,
 * run `bun scripts/router-simplify-restore.ts`, then start the older build (this build would move
 * it all again at its next boot). A value changed since (a task re-marked, a profile set) is left as
 * it is now. Each run is restored once: a second call finds nothing left to put back.
 */
export async function restoreRouterSimplify(deps: RouterSimplifyDeps = {}): Promise<number> {
  const d = defaults(deps);
  const runs = await readRuns(d.home);
  const due = runs.filter((run) => !run.restoredAt);
  for (const run of [...due].reverse()) {
    await updateRouterAreas(d.home, (current) => {
      for (const member of run.members) {
        const area = current.areas.find((one) => one.id === member.areaId);
        if (area) area.taskIds = [...new Set([...area.taskIds, ...member.taskIds])];
      }
      const restricted = new Set(run.items.map(sourceKey));
      current.openItems = (current.openItems ?? []).filter((item) => !restricted.has(sourceKey(item)));
      if (!current.openItems.length) delete current.openItems;
      const held = new Set(current.items.map(sourceKey));
      current.items = [...current.items, ...run.items.filter((item) => !held.has(sourceKey(item)))];
      const rules = new Set((current.ruleBindings ?? []).map((one) => JSON.stringify(one)));
      const back = run.ruleBindings.filter((one) => !rules.has(JSON.stringify(one)));
      if (back.length) current.ruleBindings = [...(current.ruleBindings ?? []), ...back];
      return current;
    });
    for (const mark of run.marks) await d.setMark(mark.taskId, mark.areaId);
    const live = new Map((await d.listProfiles()).map((one) => [one.sessionId, one.profile]));
    for (const one of run.profiles) if (live.has(one.sessionId) && !live.get(one.sessionId)) await d.setProfile(one.sessionId, one.profile);
    run.restoredAt = d.now().toISOString();
    await writeJsonFile(routerSimplifyBackupsPath(d.home), runs);
  }
  return due.length;
}

/** Where older builds kept a router's handoff asks (the cross-area approval this build removed). */
export const routerHandoffAsksPath = (home: string) => path.join(path.resolve(home), 'router', 'handoff-approvals.json');

const HANDOFF_RETIRED = 'Router handoffs need no approval any more: the router hands each item straight to its owner.';

/** A handoff ask still pending would do nothing when answered: each is canceled once, and marked so. */
async function retireHandoffApprovals(d: Required<RouterSimplifyDeps>): Promise<number> {
  const file = routerHandoffAsksPath(d.home);
  const saved = await readJsonFile<{ entries?: Array<{ approvalId?: unknown; state?: unknown }> } | null>(file, null).catch(() => null);
  const pending = (saved?.entries ?? []).filter((one) => one.state === 'pending' && typeof one.approvalId === 'string');
  if (!pending.length) return 0;
  let canceled = 0;
  for (const one of pending) {
    // One that could not be canceled now stays pending here and is asked again at the next boot.
    try { await d.cancelApproval(one.approvalId as string, HANDOFF_RETIRED); } catch { continue; }
    one.state = 'canceled';
    canceled += 1;
  }
  if (canceled) await writeJsonFile(file, saved, { mode: 0o600 });
  return canceled;
}
