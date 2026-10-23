import path from 'node:path';
import { getProjectMetadata } from '../task-manager.js';
import { QuickStartError } from './quick-start.js';
import { recordedCwd } from './task-start.js';
import { inheritedLaunchPair } from './caller-placement.js';
import { resolveModelSwitchValue, VALID_SESSION_EFFORT_IDS, VALID_SESSION_MODEL_IDS, VALID_SESSION_MODE_IDS } from '../types.js';
import type { Task } from '../types.js';
import type { SessionStartParams } from './task-start.js';
import { normalizeEngine } from '../agents/engine-registry.js';
import { workspaceStartPlace } from '../workspaces/launch.js';
import { belongsToWorkspace, isLaunchReady } from '../workspaces/decisions.js';

export function requireFrozenWorkspaceReady(task: Task, params: Pick<SessionStartParams, 'cwd'>) {
  if (task.workspace && (params.cwd === undefined || belongsToWorkspace(task.workspace, params.cwd)) && !isLaunchReady(task.workspace)) {
    throw new QuickStartError('This task workspace is not ready. Open the task, wait for its workspace, then review this action again.', 409);
  }
}

/** Same resolution as task_start, but without mkdir, claiming or writing anything. */
export async function resolveTaskLaunchReadOnly(task: Task, params: SessionStartParams) {
  if (params.startAttemptId || params.source === 'human-inbox') requireFrozenWorkspaceReady(task, params);
  if (params.cwd !== undefined && !params.cwd.startsWith('/')) throw new QuickStartError('cwd must be an absolute path', 400);
  if (params.mode !== undefined && !VALID_SESSION_MODE_IDS.has(params.mode)) throw new QuickStartError(`Invalid mode: ${params.mode}`, 400);
  if (params.effort !== undefined && !VALID_SESSION_EFFORT_IDS.has(params.effort)) throw new QuickStartError(`Invalid effort: ${params.effort}`, 400);
  let model: string | undefined;
  if (params.model && params.model !== 'default') {
    model = resolveModelSwitchValue(params.model) ?? undefined;
    if (!model) throw new QuickStartError(`Invalid model: ${params.model}. Use one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}`, 400);
  }
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
    const { PROJECTS_MEMORY_DIR } = await import('../../constants.js');
    cwd = path.join(PROJECTS_MEMORY_DIR, (task.project || 'inbox').toLowerCase());
    createLocalDirectory = true;
  }
  if (!host) {
    const { PROJECTS_MEMORY_DIR } = await import('../../constants.js');
    if (cwd === path.join(PROJECTS_MEMORY_DIR, (task.project || 'inbox').toLowerCase())) createLocalDirectory = true;
  }
  return { taskId: task.id, project: task.project, cwd, host, model,
    mode: params.mode, ...(params.effort ? { effort: params.effort } : {}), engine: normalizeEngine(params.engine), createLocalDirectory,
    message: params.message?.trim() || task.description || `Working on task: ${task.title}` };
}
