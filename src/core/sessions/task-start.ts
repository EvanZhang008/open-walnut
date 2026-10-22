import { randomUUID } from 'node:crypto';
import { requireFrozenWorkspaceReady, resolveTaskLaunchReadOnly } from './task-launch-plan.js';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { getTask, linkSession, updateTaskRaw } from '../task-manager.js';
import { createSessionRecord, getSessionsForTask, updateSessionRecord } from '../session-tracker.js';
import { QuickStartError } from './quick-start.js';
import { continueTaskConversation, detachTaskSession, taskConversation } from './task-session-claim.js';
import { stableJson } from '../task-create-idempotency.js';
import type { Task, SessionEngine, SessionMode } from '../types.js';
import { engineCaps, normalizeEngine, resolveEngine } from '../agents/engine-registry.js';
import { isDaemonCommandOutcomeUnknown } from '../../providers/delivery-failure.js';
import { log } from '../../logging/index.js';
import { withInboxStartAuthorization } from '../human-inbox/item-ledger.js';
import { deferTaskStart, workspaceCwdOf } from '../workspaces/launch.js';

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
  startAttemptId?: string;
  source: string;
}

export interface SessionStartResult {
  taskId: string;
  title: string;
  sessionId?: string;
  requestId?: string;
  started: boolean;
  /** The task's isolated workspace is being made; the session starts in it once it is ready. */
  preparing?: boolean;
  /** The task already had its one session: the message continued it (one-session-per-task.ts). */
  continued?: boolean;
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

/**
 * A worker session may run only so many subtasks at once (subtask-limits.ts).
 * Returns the admission's release, or throws SubtaskLimitError; the human's
 * starts and a Personal AI ask's are never limited, and a caller that cannot be
 * resolved is not either (fail open: the limit is a brake on runaway fan-out,
 * not an access check).
 */
export async function admitStartWithinLimits(task: Task, callerSid: string | undefined): Promise<() => void> {
  const open = () => {};
  if (!callerSid) return open;
  const { resolveCallerPlacement } = await import('./caller-placement.js');
  const caller = await resolveCallerPlacement(callerSid).catch(() => ({ kind: 'unknown' as const }));
  if (caller.kind !== 'worker') return open;
  const { admitSubtaskStart } = await import('./subtask-limits.js');
  return admitSubtaskStart(caller.task.id, task.id, caller.task.title);
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
  let recovery: { previousStartId: string } | undefined;
  if (params.startAttemptId) {
    if (task.phase === 'COMPLETE') throw new QuickStartError('This task changed. Review the action again.', 409);
    const { validateInboxStartBoundary } = await import('../human-inbox/item-execution.js');
    recovery = await validateInboxStartBoundary(task.id, params.startAttemptId);
    if (task.last_start && ['starting', 'unconfirmed'].includes(task.last_start.state) && recovery?.previousStartId !== task.last_start.id) {
      throw new QuickStartError('This task changed. Review the action again.', 409);
    }
  }
  const pending = pendingStarts.get(task.id);
  if (pending !== undefined) throw alreadyStarted(task, pending);
  // A frozen human plan cannot authorize a later workspace launch with different settings.
  if (params.startAttemptId) requireFrozenWorkspaceReady(task, params);
  const deferred = await deferTaskStart(task, params);
  if (deferred) return deferred;
  const engine = normalizeEngine(params.engine);
  const sid = engineCaps(engine).idProvisioning === 'provider-issued' ? undefined : randomUUID();
  const runtimeId = sid ?? `acp-${randomUUID()}`;
  // Take the slot as soon as the task id is normalized; waiting on the disk or the runner must not allow a duplicate start.
  pendingStarts.set(task.id, sid ?? '');
  let releaseOnReturn = true;
  let releaseAdmission = () => {};
  try {
    releaseAdmission = await admitStartWithinLimits(task, params.callerSid);
    const records = await getSessionsForTask(task.id);
    const live = records.find((s) => !s.archived && LIVE_STATUSES.has(s.process_status));
    const previous = records.find((s) => s.claudeSessionId === task.last_start?.session_id);
    const interrupted = (record: typeof previous) => !!record && record.claudeSessionId === task.last_start?.session_id
      && ['awaiting_spawn', 'spawn_outcome_unknown'].includes(record.status_reason ?? '');
    if (live && (recovery ? !interrupted(live) : live.status_reason !== 'awaiting_spawn')) {
      throw alreadyStarted(task, live.claudeSessionId);
    }
    if (recovery) {
      const conversation = await taskConversation(task.id);
      if (conversation && !interrupted(conversation)) throw alreadyStarted(task, conversation.claudeSessionId);
      const { validateInboxStartBoundary } = await import('../human-inbox/item-execution.js');
      const authorized = await validateInboxStartBoundary(task.id, params.startAttemptId!);
      if (authorized?.previousStartId !== task.last_start?.id) throw new QuickStartError('This task changed. Review the action again.', 409);
      // Only a confirmed recovery may cancel the old host's pending start. Keep
      // its row unchanged until the final frozen-plan check and task CAS.
      await cancelUnconfirmedStart(task, previous, true);
    } else {
      const previousConfirmed = previous && (previous.pid || previous.outputFile);
      if (live || (!previousConfirmed && (task.last_start?.state === 'unconfirmed' || task.last_start?.state === 'starting'))) {
        if (params.startAttemptId || params.source === 'human-inbox') throw new QuickStartError('The previous start needs an explicitly confirmed recovery.', 409);
        await cancelUnconfirmedStart(task, live ?? previous);
      }
    }
    // One session per task: a task that already holds a conversation continues it.
    const conversation = recovery ? undefined : await taskConversation(task.id, { retire: true });
    if (conversation) {
      if (params.startAttemptId) throw new QuickStartError('This task changed. Review the action again.', 409);
      refuseDifferentPlace(task, conversation, params);
      const sent = await continueTaskConversation(conversation, {
        text: params.message?.trim() || task.description || `Working on task: ${task.title}`,
        callerSid: params.callerSid, expectReply: params.expectReply, replyTimeoutSecs: params.replyTimeoutSecs,
      });
      return { taskId: task.id, title: task.title, sessionId: sent.sessionId, requestId: sent.requestId, started: true, continued: true };
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
      id: params.startAttemptId ?? randomUUID(), at: new Date().toISOString(), state: 'starting',
      session_id: sid, runtime_id: runtimeId, host: launch.host || '__local__', engine,
    };
    if (params.startAttemptId) {
      const { validateInboxStartBoundary } = await import('../human-inbox/item-execution.js');
      await validateInboxStartBoundary(task.id, params.startAttemptId);
    }
    const claimed = await withInboxStartAuthorization(task.id, params.startAttemptId, () => updateTaskRaw(task.id, { last_start: attempt }, {
      source: 'task-start', shouldUpdate: (current) => current.last_start?.id === task.last_start?.id
        && (!params.startAttemptId || stableJson(current.last_start) === stableJson(task.last_start)
          && current.phase !== 'COMPLETE' && current.phase === task.phase && current.cwd === task.cwd && current.project === task.project),
    }));
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
        if (recovery && previous) {
          await updateSessionRecord(previous.claudeSessionId, { process_status: 'error', status_reason: 'api_error', status_changed_by: 'session-runner' });
          await detachTaskSession(task.id, previous.claudeSessionId, 'confirmed recovery cancelled the previous pending start');
        }
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
        releaseAdmission();
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
    if (releaseOnReturn) {
      pendingStarts.delete(task.id);
      releaseAdmission();
    }
  }
}

const LOCAL_ALIASES = new Set(['', 'local', '__local__']);
const sameHost = (a?: string, b?: string) => (LOCAL_ALIASES.has(a ?? '') && LOCAL_ALIASES.has(b ?? '')) || a === b;

/** A start that names another engine, host or directory than the task's
 *  conversation is a new conversation, so it is a new task (task_transfer). */
export function refuseDifferentPlace(
  task: Task,
  conversation: Awaited<ReturnType<typeof getSessionsForTask>>[number],
  params: Pick<SessionStartParams, 'host' | 'cwd' | 'engine'>,
): void {
  const differs: string[] = [];
  if (params.host !== undefined && !sameHost(params.host, conversation.host)) differs.push(`host ${conversation.host || 'local'}`);
  if (params.cwd !== undefined && conversation.cwd && params.cwd !== conversation.cwd) differs.push(`directory ${conversation.cwd}`);
  if (params.engine !== undefined && resolveEngine(params.engine) !== resolveEngine(conversation.engine)) {
    differs.push(`engine ${resolveEngine(conversation.engine)}`);
  }
  if (differs.length === 0) return;
  throw new QuickStartError(
    `Task ${task.id} already has its one session (${differs.join(', ')}). A task keeps one conversation: `
    + `continue it with task_send, or move the work with task_transfer {"id":"${task.id}"} to a new task on the other engine or host.`, 409);
}

async function cancelUnconfirmedStart(task: Task, record?: Awaited<ReturnType<typeof getSessionsForTask>>[number], keepRecord = false): Promise<void> {
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
    if (!result.ok || result.cancelled !== true || result.alive !== false) throw new Error(String(result.error || 'Previous start could not be cancelled'));
    if (record && !keepRecord) await updateSessionRecord(record.claudeSessionId, { process_status: 'error', status_reason: 'api_error', status_changed_by: 'session-runner' });
  } catch (error) {
    if (error instanceof SessionExistsError) throw error;
    throw new QuickStartError(`Task ${task.id} still has an unconfirmed start: ${String(error)}. Retry task_start with this id after the host reconnects; do not create another task.`, 409);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The cwd a task has on record for a start that names none: its own, else the
 * nearest ancestor's, walking the parent chain only while it stays in the task's
 * project. A task stores a cwd but no host, so a recorded cwd lives on its
 * project's default host; a parent in another project recorded a path on THAT
 * project's host, and handing it down would pair it with this project's host
 * (2026-10-02: a leader on a remote host filed a task into a project whose
 * default host is the local box, and the first start died on a path that only
 * exists remotely).
 */
export async function recordedCwd(task: Pick<Task, 'id' | 'project' | 'cwd' | 'parent_task_id' | 'workspace'>): Promise<string | undefined> {
  const project = (task.project ?? '').trim().toLowerCase();
  let current: Pick<Task, 'id' | 'project' | 'cwd' | 'parent_task_id' | 'workspace'> | undefined = task;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if ((current.project ?? '').trim().toLowerCase() !== project) return undefined;
    // A ready isolated workspace is where the task's work lives (core/workspaces).
    const own = workspaceCwdOf(current) ?? current.cwd;
    if (own) return own;
    seen.add(current.id);
    current = current.parent_task_id ? await getTask(current.parent_task_id).catch(() => undefined) : undefined;
  }
  return undefined;
}

async function prepareLaunch(task: Task, params: SessionStartParams) {
  const launch = await resolveTaskLaunchReadOnly(task, params);
  if (launch.createLocalDirectory) await mkdir(launch.cwd, { recursive: true });
  const { createLocalDirectory, ...resolved } = launch;
  return resolved;
}
