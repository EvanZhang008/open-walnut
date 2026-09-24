import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { getTask, getProjectMetadata, linkSession, updateTaskRaw } from '../task-manager.js';
import { createSessionRecord, getSessionsForTask, updateSessionRecord } from '../session-tracker.js';
import { QuickStartError } from './quick-start.js';
import { inheritedLaunchPair } from './caller-placement.js';
import { resolveModelSwitchValue, VALID_SESSION_MODEL_IDS, VALID_SESSION_MODE_IDS } from '../types.js';
import type { Task, SessionEngine, SessionMode } from '../types.js';
import { engineCaps, normalizeEngine } from '../agents/engine-registry.js';
import { isDaemonCommandOutcomeUnknown } from '../../providers/delivery-failure.js';
import { log } from '../../logging/index.js';

export interface SessionStartParams {
  taskIdPrefix: string;
  message?: string;
  cwd?: string;
  host?: string;
  model?: string;
  mode?: string;
  engine?: SessionEngine;
  expectReply?: boolean;
  replyTimeoutSecs?: number;
  callerSid?: string;
  source: string;
}

export interface SessionStartResult {
  taskId: string;
  title: string;
  sessionId?: string;
  requestId?: string;
  started: boolean;
}

export class SessionExistsError extends QuickStartError {
  constructor(message: string, public existingSessionId: string) {
    super(message, 409);
    this.name = 'SessionExistsError';
  }
}

const pendingStarts = new Map<string, string>();
const LIVE_STATUSES = new Set(['running', 'idle']);
const START_RESPONSE_BUDGET_MS = 5_000;

export function isTaskStarting(taskId: string): boolean {
  return pendingStarts.has(taskId);
}

function alreadyStarted(task: Task, sid: string): SessionExistsError {
  return new SessionExistsError(
    `Task "${task.title}" is already started or starting. Continue with task_send {"to":"${task.id}","text":"..."}.`, sid);
}

export async function startSessionForTask(params: SessionStartParams): Promise<SessionStartResult> {
  let task: Task;
  try {
    task = await getTask(params.taskIdPrefix);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('No task found matching')) throw new QuickStartError(message, 404);
    if (message.includes('Ambiguous ID prefix')) throw new QuickStartError(message, 400);
    throw err;
  }
  const pending = pendingStarts.get(task.id);
  if (pending !== undefined) throw alreadyStarted(task, pending);
  const engine = normalizeEngine(params.engine);
  const sid = engineCaps(engine).idProvisioning === 'provider-issued' ? undefined : randomUUID();
  const runtimeId = sid ?? `acp-${randomUUID()}`;
  // Take the slot as soon as the task id is normalized; waiting on the disk or the runner must not allow a duplicate start.
  pendingStarts.set(task.id, sid ?? '');
  let releaseOnReturn = true;
  try {
    const records = await getSessionsForTask(task.id);
    const live = records.find((s) => !s.archived && LIVE_STATUSES.has(s.process_status));
    if (live && live.status_reason !== 'awaiting_spawn') throw alreadyStarted(task, live.claudeSessionId);
    const previous = records.find((s) => s.claudeSessionId === task.last_start?.session_id);
    const previousConfirmed = previous && (previous.pid || previous.outputFile);
    if (live || (!previousConfirmed && (task.last_start?.state === 'unconfirmed' || task.last_start?.state === 'starting'))) {
      await cancelUnconfirmedStart(task, live ?? previous);
    }
    const launch = await prepareLaunch(task, { ...params, engine });
    let callerSessionId: string | undefined;
    let requestId: string | undefined;
    if (params.expectReply !== false) {
      const { resolveCaller } = await import('./session-send-core.js');
      const caller = await resolveCaller(params.callerSid);
      if (caller.kind !== 'session') {
        if (params.expectReply === true) throw new QuickStartError('expect_reply needs a session caller', 400);
      } else {
        callerSessionId = caller.record.claudeSessionId;
      }
    }
    const attempt: NonNullable<Task['last_start']> = {
      id: randomUUID(), at: new Date().toISOString(), state: 'starting',
      session_id: sid, runtime_id: runtimeId, host: launch.host || '__local__', engine,
    };
    const claimed = await updateTaskRaw(task.id, { last_start: attempt }, {
      source: 'task-start', shouldUpdate: (current) => current.last_start?.id === task.last_start?.id,
    });
    if (!claimed.changed) throw new QuickStartError(`Task ${task.id} changed before its start could be recorded. Read task_get before retrying.`, 409);
    const settle = async (updates: Partial<NonNullable<Task['last_start']>>) => {
      try {
        await updateTaskRaw(task.id, { last_start: { ...attempt, ...updates } },
          { source: 'task-start', shouldUpdate: (current) => current.last_start?.id === attempt.id });
      } catch (error) {
        log.session.error('Failed to persist task start outcome', { taskId: task.id, attemptId: attempt.id, error: String(error) });
      }
    };
    let seeded = false;
    const result: SessionStartResult = { taskId: task.id, title: task.title, sessionId: sid, requestId, started: false };
    const work = (async (): Promise<SessionStartResult> => {
      try {
        if (callerSessionId) {
          const { createSessionRequest, buildReplyTrailer } = await import('../session-requests.js');
          const request = await createSessionRequest({
            fromSessionId: callerSessionId, ...(sid ? { toSessionId: sid } : {}),
            toTaskId: task.id, text: launch.message, replyTimeoutSecs: params.replyTimeoutSecs,
            implicit: params.expectReply === undefined,
          });
          requestId = request.id;
          result.requestId = request.id;
          launch.message += `\n${buildReplyTrailer(request)}`;
        }
        if (sid) {
          await createSessionRecord(sid, task.id, task.project ?? '', launch.cwd, {
            title: task.title, host: launch.host, mode: params.mode as SessionMode | undefined,
            engine, initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
          });
          seeded = true;
          await linkSession(task.id, sid);
        }
        const { sessionRunner } = await import('../../providers/claude-code-session.js');
        const starting = sessionRunner.startSession({ ...launch, preassignedSessionId: sid, runtimeId: sid ? undefined : runtimeId, waitForSpawn: true }).then(async (ready) => {
          await settle({ state: 'started', session_id: ready.claudeSessionId });
          return { ...result, sessionId: ready.claudeSessionId, started: true };
        }, async (error) => {
          await settle({ state: isDaemonCommandOutcomeUnknown(error) ? 'unconfirmed' : 'failed', error: String(error) });
          throw error;
        });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([starting, new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('daemon command timeout: task start confirmation (120000ms)')), 120_000);
          })]);
        } finally {
          if (deadline) clearTimeout(deadline);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A timeout does not prove the process never started; keep the start record and let the normal state reconciliation path confirm it.
        const uncertain = isDaemonCommandOutcomeUnknown(err);
        await settle({ state: uncertain ? 'unconfirmed' : 'failed', error: message });
        if (seeded && sid) {
          await updateSessionRecord(sid, {
            process_status: 'error', errorMessage: message,
            status_reason: uncertain ? 'spawn_outcome_unknown' : 'api_error', status_changed_by: 'session-runner',
            ...(uncertain ? { errorKind: 'infra' as const } : {}),
          }).catch(() => {});
        }
        if (requestId && !uncertain) {
          const { getSessionRequest } = await import('../session-requests.js');
          const { notifyRequesterFallback } = await import('./session-request-notify.js');
          const request = await getSessionRequest(requestId);
          if (request) await notifyRequesterFallback(request, 'error');
        }
        if (uncertain) return result;
        throw new QuickStartError(`Task ${task.id} could not start: ${message}. Fix the cause and retry task_start with the same id.`, 502);
      } finally {
        pendingStarts.delete(task.id);
      }
    })();
    releaseOnReturn = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<SessionStartResult>((resolve) => {
          timer = setTimeout(() => resolve(result), START_RESPONSE_BUDGET_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    if (releaseOnReturn) pendingStarts.delete(task.id);
  }
}

async function cancelUnconfirmedStart(task: Task, record?: Awaited<ReturnType<typeof getSessionsForTask>>[number]): Promise<void> {
  const attempt = task.last_start;
  const runtimeId = attempt?.runtime_id || attempt?.session_id || record?.claudeSessionId;
  if (!runtimeId) throw new QuickStartError(`Task ${task.id} has an unconfirmed start without a runtime identity. Read task_get; another start cannot be safely issued.`, 409);
  const host = attempt?.host || record?.host || '__local__';
  const { getConnectedDaemonConnection, getDaemonConnection } = await import('../../providers/daemon-connection.js');
  const reconcile = async () => {
    let conn = getConnectedDaemonConnection(host);
    if (!conn) {
      const { getConfig } = await import('../config-manager.js');
      const entry = (await getConfig()).hosts?.[host];
      if (host !== '__local__' && !entry) throw new Error(`Unknown host: ${host}`);
      conn = await getDaemonConnection(host, { hostname: host === '__local__' ? host : (entry?.hostname || host), user: entry?.user, port: entry?.port });
    }
    if (!conn.hasCapability('cancel-pending-start-v1')) throw new Error('The execution host needs a daemon upgrade before this start can be retried');
    return conn.send('cancelPendingStart', { sid: runtimeId }, 5_000);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([reconcile(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The execution host has not confirmed the previous start outcome')), 8_000);
    })]);
    if (result.alive) throw alreadyStarted(task, record?.claudeSessionId || '');
    if (!result.ok || result.cancelled !== true) throw new Error(String(result.error || 'Previous start could not be cancelled'));
    if (record) await updateSessionRecord(record.claudeSessionId, { process_status: 'error', status_reason: 'api_error', status_changed_by: 'session-runner' });
  } catch (error) {
    if (error instanceof SessionExistsError) throw error;
    throw new QuickStartError(`Task ${task.id} still has an unconfirmed start: ${String(error)}. Retry task_start with this id after the host reconnects; do not create another task.`, 409);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function prepareLaunch(task: Task, params: SessionStartParams) {
  if (params.cwd !== undefined && !params.cwd.startsWith('/')) throw new QuickStartError('cwd must be an absolute path', 400);
  if (params.mode !== undefined && !VALID_SESSION_MODE_IDS.has(params.mode)) {
    throw new QuickStartError(`Invalid mode: ${params.mode}`, 400);
  }
  let model: string | undefined;
  if (params.model && params.model !== 'default') {
    model = resolveModelSwitchValue(params.model) ?? undefined;
    if (!model) throw new QuickStartError(`Invalid model: ${params.model}. Use one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}`, 400);
  }
  const metadata = await getProjectMetadata(task.project || '');
  let cwd = params.cwd;
  let current: Task | undefined = task;
  const seen = new Set<string>();
  while (!cwd && current && !seen.has(current.id)) {
    seen.add(current.id);
    cwd = current.cwd;
    current = !cwd && current.parent_task_id ? await getTask(current.parent_task_id) : undefined;
  }
  // A worker starting another task of its own project, with no place named and
  // none recorded, runs it where the worker runs: host and cwd as ONE pair, so
  // a path never lands on a machine it does not exist on (caller-placement.ts).
  const pair = !cwd && params.host === undefined && params.callerSid
    ? await inheritedLaunchPair(params.callerSid, task).catch(() => undefined)
    : undefined;
  const requestedHost = params.host ?? (pair ? pair.host : metadata?.default_host);
  const host = requestedHost === '__local__' || requestedHost === 'local' ? '' : requestedHost;
  if (host && host !== '__local__' && host !== 'local') {
    const { getConfig } = await import('../config-manager.js');
    const entry = (await getConfig()).hosts?.[host];
    if (!entry || entry.enabled === false) throw new QuickStartError(`Unknown host: ${host}`, 400);
  }
  cwd ||= pair?.cwd || metadata?.default_cwd;
  if (!cwd) {
    if (host && host !== '__local__' && host !== 'local') {
      throw new QuickStartError(`Task ${task.id} needs a cwd on host "${host}". Pass cwd or set project default_cwd.`, 400);
    }
    const { PROJECTS_MEMORY_DIR } = await import('../../constants.js');
    cwd = path.join(PROJECTS_MEMORY_DIR, (task.project || 'inbox').toLowerCase());
    await mkdir(cwd, { recursive: true });
  }
  return {
    taskId: task.id, project: task.project, cwd, host, model,
    mode: params.mode, engine: params.engine,
    message: params.message?.trim() || task.description || `Working on task: ${task.title}`,
  };
}
