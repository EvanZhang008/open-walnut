import { getProjectMetadata } from '../task-manager.js';
import { QuickStartError } from './quick-start.js';
import { recordedCwd } from './task-start.js';
import { inheritedLaunchPair } from './caller-placement.js';
import { ancestorFolderYields, defaultCwdOnHost, recordedCwdOnHost } from './launch-place.js';
import { resolveModelSwitchValue, VALID_SESSION_EFFORT_IDS, VALID_SESSION_MODEL_IDS, VALID_SESSION_MODE_IDS } from '../types.js';
import type { Task } from '../types.js';
import type { SessionStartParams } from './task-start.js';
import { isAcpEngine, normalizeEngine } from '../agents/engine-registry.js';
import { workspaceStartPlace } from '../workspaces/launch.js';
import { belongsToWorkspace, isLaunchReady } from '../workspaces/decisions.js';

export function requireFrozenWorkspaceReady(task: Task, params: Pick<SessionStartParams, 'cwd'>) {
  if (task.workspace && (params.cwd === undefined || belongsToWorkspace(task.workspace, params.cwd)) && !isLaunchReady(task.workspace)) {
    throw new QuickStartError('This task workspace is not ready. Open the task, wait for its workspace, then review this action again.', 409);
  }
}

/**
 * The launch choices a start names, checked before anything is written or
 * deferred: a start waiting for its workspace replays them later, and a bad one
 * must fail now, not as a launch error after the caller was told "preparing".
 */
export function validateLaunchChoices(params: SessionStartParams): void {
  if (params.cwd !== undefined && !params.cwd.startsWith('/')) throw new QuickStartError('cwd must be an absolute path', 400);
  if (params.mode !== undefined && !VALID_SESSION_MODE_IDS.has(params.mode)) throw new QuickStartError(`Invalid mode: ${params.mode}`, 400);
  if (params.effort !== undefined && !VALID_SESSION_EFFORT_IDS.has(params.effort)) throw new QuickStartError(`Invalid effort: ${params.effort}`, 400);
  // An ACP engine takes effort as a setting of its running session, not at spawn
  // (quick-start drops it for the same reason), so a start that names one would be
  // told its effort was applied when nothing carried it.
  if (params.effort !== undefined && isAcpEngine(normalizeEngine(params.engine))) {
    throw new QuickStartError(`effort applies to the claude engine; ${params.engine} sets its reasoning level inside its running session`, 400);
  }
  if (params.model && params.model !== 'default' && !resolveModelSwitchValue(params.model)) {
    throw new QuickStartError(`Invalid model: ${params.model}. Use one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}`, 400);
  }
  if (params.workspace && params.createCwd) {
    throw new QuickStartError('create_cwd and workspace do not combine: a workspace copies a folder that already exists', 400);
  }
}

/**
 * Same resolution as task_start, but without mkdir, claiming or writing anything. `preview`: a
 * plan shown before anything starts (the Org page's draft, an inbox action's plan), which never
 * waits on a host link.
 */
export async function resolveTaskLaunchReadOnly(task: Task, params: SessionStartParams, opts: { preview?: boolean } = {}) {
  if (params.startAttemptId || params.source === 'human-inbox') requireFrozenWorkspaceReady(task, params);
  validateLaunchChoices(params);
  if (params.callerSid) {
    const { capStartMode } = await import('./delegated-mode.js');
    params = { ...params, mode: await capStartMode(params.callerSid, params.mode) };
  }
  const model = params.model && params.model !== 'default' ? resolveModelSwitchValue(params.model) ?? undefined : undefined;
  const metadata = await getProjectMetadata(task.project || '');
  const wsPlace = workspaceStartPlace(task, params);
  // A start that names a host takes only a recorded folder that lives on it (launch-place.ts).
  const named = !wsPlace && params.host !== undefined;
  let cwd = wsPlace?.cwd ?? params.cwd
    ?? (named ? await recordedCwdOnHost(task, params.host, metadata?.default_host) : await recordedCwd(task));
  // The creating session's place, when the task has no folder of its own: also over an
  // ancestor's folder on another host (launch-place.ts ancestorFolderYields).
  const fromRecord = !wsPlace && params.cwd === undefined && !!cwd;
  let pair = (!cwd || fromRecord) && params.host === undefined && params.callerSid
    ? await inheritedLaunchPair(params.callerSid, task).catch(() => undefined) : undefined;
  if (pair && cwd) {
    const text = [task.title, task.description ?? '', params.message ?? ''].join('\n');
    const { needsMacTools } = await import('../hosts/placement.js');
    const { namedPaths } = await import('../hosts/named-paths.js');
    const yields = await ancestorFolderYields(task, pair.host, metadata?.default_host, {
      // ./ and ../ read against the folder that would yield, before it is given up (review round 5, Sol).
      macTools: needsMacTools(text, cwd, task.tags ?? []), paths: namedPaths(text, undefined, { cwd }),
    }).catch(() => false);
    if (yields) cwd = undefined;
    else pair = undefined;
  }
  const requestedHost = wsPlace ? wsPlace.host : params.host ?? (pair ? pair.host : metadata?.default_host);
  const host = requestedHost === '__local__' || requestedHost === 'local' ? '' : requestedHost;
  if (host) {
    const { getConfig } = await import('../config-manager.js');
    const entry = (await getConfig()).hosts?.[host];
    if (!entry || entry.enabled === false) throw new QuickStartError(`Unknown host: ${host}`, 400);
  }
  // A host the caller handed on without a folder counts as named: only a default on it applies.
  const onHost = named || (!!pair && !pair.cwd);
  cwd ||= pair?.cwd || (onHost ? defaultCwdOnHost(metadata, host) : metadata?.default_cwd);
  let createTaskDir = false;
  // A VP or lead runs in its own task directory, whatever the task or its project recorded,
  // unless a person named the folder for this start (org-own-folder.ts). A workspace (the
  // task's, or one given for this start) is an isolated copy, never the repository: it keeps
  // its folder.
  const { ownFolderStartCwd } = await import('./org-own-folder.js');
  const own = wsPlace || params.workspace ? null : await ownFolderStartCwd(task, host, params, opts);
  // A preview on a host that has not said its root: no folder yet, the start learns it.
  const ownFolderPending = own?.kind === 'own' && !own.cwd;
  if (own?.kind === 'own') { cwd = own.cwd ?? undefined; createTaskDir = true; }
  // A named remote host with no folder of this task's there: the task's own directory on it.
  if (!cwd && onHost && host && !ownFolderPending) {
    const { taskDirForHost } = await import('./task-dir-place.js');
    const dir = await taskDirForHost(task.id, host).catch(() => null);
    if (dir) { cwd = dir; createTaskDir = true; }
  }
  if (!cwd && ownFolderPending) {
    // Nothing to name: the plan says where it starts, its own directory there, once it starts.
  } else if (!cwd) {
    if (host) throw new QuickStartError(`Task ${task.id} needs a cwd on host "${host}". Pass cwd or set project default_cwd.`, 400);
    // No folder anywhere: the task's own directory on this Mac (never the memory tree).
    const { taskDirForHost } = await import('./task-dir-place.js');
    const dir = await taskDirForHost(task.id, '__local__');
    if (!dir) throw new QuickStartError(`Task ${task.id} has no folder: pass cwd.`, 400);
    cwd = dir;
    createTaskDir = true;
  } else if (!host && !createTaskDir) {
    // A start pinned to the folder this plan named before (an org contact's draft).
    const { taskDirForHost } = await import('./task-dir-place.js');
    if (cwd === await taskDirForHost(task.id, '__local__')) createTaskDir = true;
  }
  return { taskId: task.id, project: task.project, cwd: cwd ?? '', host, model, createTaskDir, cwdByPerson: own?.kind === 'person',
    mode: params.mode, ...(params.effort ? { effort: params.effort } : {}), engine: normalizeEngine(params.engine),
    message: params.idle ? '' : params.message?.trim() || task.description || `Working on task: ${task.title}` };
}
