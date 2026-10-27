import path from 'node:path';
import { PROJECTS_MEMORY_DIR } from '../../constants.js';
import { getProjectMetadata } from '../task-manager.js';
import { QuickStartError } from './quick-start.js';
import { recordedCwd } from './task-start.js';
import { inheritedLaunchPair } from './caller-placement.js';
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

/** The folder a task with no folder of its own starts in on this machine; its start makes it. */
export function taskMemoryFolder(project: string | undefined): string {
  return path.join(PROJECTS_MEMORY_DIR, (project || 'inbox').toLowerCase());
}

/** A folder strictly inside PROJECTS_MEMORY_DIR (a project name with `..` lands outside it). */
export function insideMemoryFolders(dir: string): boolean {
  const rel = path.relative(PROJECTS_MEMORY_DIR, dir);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
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

/** Same resolution as task_start, but without mkdir, claiming or writing anything. */
export async function resolveTaskLaunchReadOnly(task: Task, params: SessionStartParams) {
  if (params.startAttemptId || params.source === 'human-inbox') requireFrozenWorkspaceReady(task, params);
  validateLaunchChoices(params);
  const model = params.model && params.model !== 'default' ? resolveModelSwitchValue(params.model) ?? undefined : undefined;
  const metadata = await getProjectMetadata(task.project || '');
  const wsPlace = workspaceStartPlace(task, params);
  let cwd = wsPlace?.cwd ?? params.cwd ?? await recordedCwd(task);
  const pair = !cwd && params.host === undefined && params.callerSid
    ? await inheritedLaunchPair(params.callerSid, task).catch(() => undefined) : undefined;
  const requestedHost = wsPlace ? wsPlace.host : params.host ?? (pair ? pair.host : metadata?.default_host);
  const host = requestedHost === '__local__' || requestedHost === 'local' ? '' : requestedHost;
  if (host) {
    const { getConfig } = await import('../config-manager.js');
    const entry = (await getConfig()).hosts?.[host];
    if (!entry || entry.enabled === false) throw new QuickStartError(`Unknown host: ${host}`, 400);
  }
  cwd ||= pair?.cwd || metadata?.default_cwd;
  let createLocalDirectory = false;
  if (!cwd) {
    if (host) throw new QuickStartError(`Task ${task.id} needs a cwd on host "${host}". Pass cwd or set project default_cwd.`, 400);
    cwd = taskMemoryFolder(task.project);
    createLocalDirectory = true;
  }
  if (!host && cwd === taskMemoryFolder(task.project)) createLocalDirectory = true;
  return { taskId: task.id, project: task.project, cwd, host, model,
    mode: params.mode, ...(params.effort ? { effort: params.effort } : {}), engine: normalizeEngine(params.engine), createLocalDirectory,
    message: params.message?.trim() || task.description || `Working on task: ${task.title}` };
}
