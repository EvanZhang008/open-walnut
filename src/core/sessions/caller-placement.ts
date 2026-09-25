/**
 * Where work created FROM INSIDE a task lands.
 *
 * A coding session that files a task (because the user asked it to) used to put
 * it wherever the arguments said, and the arguments usually said nothing: the
 * task went to the Inbox, outside any folder, and its first run started in a
 * memory directory instead of the repo the caller was working in. Agents wrote
 * `task_create {"title":...}` and the board filled with orphans.
 *
 * The rule now, enforced here on the server so every surface (CLI shim, MCP,
 * daemon gateway) gets it from one request, cascades like this:
 *
 *     explicit argument  →  the calling task's value  →  the container default
 *
 *   - project: the caller's project unless the call names one ('' = Inbox, on
 *     purpose).
 *   - folder:  only inside the caller's project. The caller's folder when it has
 *     one; otherwise a new folder is made holding the caller AND the new task
 *     (the same shape a fork produces). A folder never follows work into another
 *     project, because a folder is that project's private structure.
 *   - parent: a task that lands in the caller's project is a SUBTASK of the
 *     caller (`parent_task_id`), the same relation a promoted side question
 *     gets. The board marks it with a Sub pill and the parent counts it, so
 *     work an agent split off stays visibly attached to the work it came from.
 *     Filed into another project it is independent work, not a subtask.
 *   - host + cwd: travel together (a cwd is only meaningful on its host). At
 *     create time the caller's cwd is stamped on the task when it belongs to the
 *     host the task would launch on anyway; at start time a task with no cwd of
 *     its own takes the caller's host AND cwd as a pair.
 *
 * Only a WORKER caller (a session running a regular task) is placed from. The
 * Personal AI's own conversations are sessions too, but their tasks live in the
 * `Ask …` projects, and filing the user's work there would bury it. Humans,
 * external processes and a cloud replica (no session registry) keep the old
 * behaviour.
 */

import path from 'node:path';
import { CLOUD_MODE, PROJECTS_MEMORY_DIR } from '../../constants.js';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';

/** The caller's task, as placement needs it. */
export interface CallerTask {
  id: string;
  title: string;
  project: string;
  group_id?: string;
  group_label?: string;
}

/** The caller's session, as launch inheritance needs it. '' host = this box. */
export interface CallerSession {
  id: string;
  host: string;
  cwd?: string;
}

export type CallerPlacement =
  | { kind: 'human' }
  | { kind: 'external' }
  | { kind: 'unknown' }
  | { kind: 'untracked'; session: CallerSession }
  | { kind: 'ask'; task: CallerTask; session: CallerSession }
  | { kind: 'worker'; task: CallerTask; session: CallerSession };

/** Case-insensitive project identity (matches the registry's COLLATE NOCASE). */
export function sameProject(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

/** '' / '__local__' / 'local' / undefined all mean this box. */
export function normalizeHost(host: string | undefined | null): string {
  const h = (host ?? '').trim();
  return h === '__local__' || h === 'local' ? '' : h;
}

/**
 * Classify the caller behind an `x-walnut-caller-sid` header. Reads the task's
 * LIVE project and folder: `SessionRecord.project` is stamped when the session
 * starts and goes stale the moment the task moves.
 */
export async function resolveCallerPlacement(callerSid: string | undefined): Promise<CallerPlacement> {
  const sid = (callerSid ?? '').trim();
  if (!sid) return { kind: 'human' };
  if (CLOUD_MODE) return { kind: 'unknown' };
  const { resolveCaller } = await import('./session-send-core.js');
  const caller = await resolveCaller(sid).catch(() => ({ kind: 'external' as const }));
  if (caller.kind !== 'session') return { kind: caller.kind === 'human' ? 'human' : 'external' };
  const record = caller.record;
  const session: CallerSession = {
    id: record.claudeSessionId,
    host: normalizeHost(record.host),
    ...(record.cwd ? { cwd: record.cwd } : {}),
  };
  if (!record.taskId) return { kind: 'untracked', session };
  const { getTask, listFolderLabels } = await import('../task-manager.js');
  const task = await getTask(record.taskId).catch(() => undefined);
  if (!task) return { kind: 'untracked', session };
  const groupId = task.group_id || undefined;
  const label = groupId ? (await listFolderLabels().catch(() => new Map<string, string>())).get(groupId) : undefined;
  const callerTask: CallerTask = {
    id: task.id,
    title: task.title,
    project: task.project ?? '',
    ...(groupId ? { group_id: groupId } : {}),
    ...(label ? { group_label: label } : {}),
  };
  return { kind: isAskTask(task) ? 'ask' : 'worker', task: callerTask, session };
}

/**
 * A Personal AI conversation: born `walnut_agent`, or filed under an agent's
 * `Ask …` project (the same two tests the chat drawer uses to list asks).
 */
function isAskTask(task: { walnut_agent?: boolean; project?: string }): boolean {
  return task.walnut_agent === true || /^ask /i.test((task.project ?? '').trim());
}

/** What a create request asked for (undefined = not said). */
export interface PlacementRequest {
  project?: string;
  group_id?: string;
  /** Where the first start was told to run (task_create's cwd / host). Hints
   *  only: they decide what cwd the task records, never where it is filed. */
  launch_cwd?: string;
  launch_host?: string;
}

/** What the create should do. `project` undefined = let addTask apply its own default. */
export interface PlacementDecision {
  project?: string;
  group_id?: string;
  /** Make a new folder holding the caller and the new task once it exists. */
  createFolderWithCaller: boolean;
  /** Set when the caller's placement was used (project, folder or both). */
  inheritedFrom?: string;
  /** The caller's task, when the new task lands in its project: the parent. */
  parentTaskId?: string;
}

/** Pure: the placement rule table (see the module header). */
export function decidePlacement(req: PlacementRequest, caller: CallerPlacement): PlacementDecision {
  const explicitGroup = req.group_id === undefined ? undefined : (req.group_id || undefined);
  if (caller.kind !== 'worker') {
    return { project: req.project, group_id: explicitGroup, createFolderWithCaller: false };
  }
  const project = req.project !== undefined ? req.project : caller.task.project;
  const own = sameProject(project, caller.task.project);
  const parent = own ? { parentTaskId: caller.task.id } : {};
  // A folder is inherited only inside the caller's own project.
  if (req.group_id !== undefined || !own) {
    return {
      project,
      group_id: explicitGroup,
      createFolderWithCaller: false,
      ...(req.project === undefined ? { inheritedFrom: caller.task.id } : {}),
      ...parent,
    };
  }
  return caller.task.group_id
    ? { project, group_id: caller.task.group_id, createFolderWithCaller: false, inheritedFrom: caller.task.id, ...parent }
    : { project, createFolderWithCaller: true, inheritedFrom: caller.task.id, ...parent };
}

/**
 * The cwd a task a worker creates should RECORD, or undefined.
 *
 * A task stores a cwd but no host: a later start from the board runs it on the
 * project's default host. So a cwd is recorded only when it belongs to that
 * host, otherwise a restart sends a path to a machine it does not exist on:
 *   - the create names a host: record its cwd only if that host IS the default;
 *   - it names only a cwd: that cwd (its start runs on the default host too);
 *   - it names neither and lands in the caller's project: the caller's cwd, when
 *     the caller runs on the default host and the cwd is not simply the default
 *     the task would get anyway (recording that would freeze it, so a later
 *     change of the project's default_cwd would no longer reach this task).
 */
export async function createTimeCwd(
  req: PlacementRequest,
  caller: CallerPlacement,
  decision: PlacementDecision,
): Promise<string | undefined> {
  if (caller.kind !== 'worker') return undefined;
  const project = decision.project ?? '';
  const { getProjectMetadata } = await import('../task-manager.js');
  const meta = await getProjectMetadata(project).catch(() => null);
  const defaultHost = normalizeHost(meta?.default_host);
  if (req.launch_host !== undefined) {
    return normalizeHost(req.launch_host) === defaultHost ? req.launch_cwd : undefined;
  }
  if (req.launch_cwd !== undefined) return req.launch_cwd;
  const cwd = caller.session.cwd;
  if (!cwd || !sameProject(project, caller.task.project) || caller.session.host !== defaultHost) return undefined;
  const memoryDir = path.join(PROJECTS_MEMORY_DIR, (project || 'inbox').toLowerCase());
  return cwd === meta?.default_cwd || cwd === memoryDir ? undefined : cwd;
}

/**
 * The host + cwd pair a start inherits from its caller, or undefined. Applies
 * only to a worker starting another task of its own project that names neither
 * and has no cwd of its own (task / parent chain), so an explicit or recorded
 * place always wins and the pair never splits across machines.
 */
export async function inheritedLaunchPair(
  callerSid: string | undefined,
  task: { id: string; project?: string },
): Promise<{ host: string; cwd: string } | undefined> {
  const caller = await resolveCallerPlacement(callerSid).catch(() => undefined);
  if (caller?.kind !== 'worker' || !caller.session.cwd) return undefined;
  if (caller.task.id === task.id || !sameProject(task.project, caller.task.project)) return undefined;
  const host = caller.session.host;
  if (host) {
    const { getConfig } = await import('../config-manager.js');
    const entry = (await getConfig()).hosts?.[host];
    if (!entry || entry.enabled === false) {
      log.session.warn('caller host is not usable, launching from project defaults', { host, taskId: task.id });
      return undefined;
    }
  }
  return { host, cwd: caller.session.cwd };
}

/**
 * Put `newTaskId` beside `source`: into the source's folder when it has one,
 * otherwise into a new folder holding both, labelled with the source title and
 * refined to an AI group name in the background. Best-effort: a failure leaves
 * the new task standalone in its project and is reported, never thrown.
 * Shared by forks, side-thread promotion and caller placement.
 */
export async function joinOrCreateSiblingFolder(
  source: { id: string; title: string; group_id?: string },
  newTaskId: string,
  opts: { eventSource: string; refineTitles?: string[] },
): Promise<{ groupId?: string; label?: string; created: boolean; error?: string }> {
  const { placeInFolderBeside, renameGroup } = await import('../task-manager.js');
  try {
    // One write lock decides join-or-create against the source's CURRENT folder
    // (a stale "no folder" must never merge a folder the user just made).
    const r = await placeInFolderBeside(source.id, newTaskId, source.title);
    if (!r.created) return { groupId: r.group_id, label: r.label, created: false };
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: r.group_id, label: r.label }, ['web-ui'], { source: opts.eventSource });
    const gid = r.group_id;
    const titles = opts.refineTitles ?? [source.title];
    void (async () => {
      try {
        const { summarizeGroupLabel } = await import('../fork-title.js');
        const label = await summarizeGroupLabel(titles);
        if (!label) return;
        await renameGroup(gid, label);
        bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: gid, label }, ['web-ui'], { source: opts.eventSource });
        log.session.info('sibling folder label refined', { groupId: gid, label });
      } catch (err) {
        log.session.warn('sibling folder label refine failed', {
          groupId: gid, error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return { groupId: gid, label: r.label, created: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.session.warn('could not put the new task beside its source', {
      sourceTaskId: source.id, newTaskId, error,
    });
    return { created: false, error };
  }
}
