import { randomUUID } from 'node:crypto';
import { requireFrozenWorkspaceReady, resolveTaskLaunchReadOnly, validateLaunchChoices } from './task-launch-plan.js';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { getTask, linkSession, updateTaskRaw } from '../task-manager.js';
import { createSessionRecord, getSessionsForTask, updateSessionRecord } from '../session-tracker.js';
import { QuickStartError } from './quick-start.js';
import { continueTaskConversation, detachTaskSession, taskConversation } from './task-session-claim.js';
import { stableJson } from '../task-create-idempotency.js';
import type { Task, SessionEffort, SessionEngine, SessionMode } from '../types.js';
import { engineCaps, normalizeEngine, resolveEngine } from '../agents/engine-registry.js';
import { isDaemonCommandOutcomeUnknown } from '../../providers/delivery-failure.js';
import { log } from '../../logging/index.js';
import { withInboxStartAuthorization } from '../human-inbox/item-ledger.js';
import { deferTaskStart, requestTaskStartWorkspace, willDeferStart, workspaceCwdOf } from '../workspaces/launch.js';
import { isLaunchReady } from '../workspaces/decisions.js';

export interface SessionStartParams {
  taskIdPrefix: string;
  message?: string;
  cwd?: string;
  host?: string;
  model?: string;
  mode?: string;
  /** Reasoning effort for the spawn (Claude Code's --effort). */
  effort?: SessionEffort;
  /** The user's own words asking for this start: lifts the running-subtask brake to its higher ceiling (subtask-limits.ts). */
  userRequest?: string;
  /** "Create folder & start": make `cwd` on its host first (ensureCwd, as quick-start's createCwd). */
  createCwd?: boolean;
  /** An isolated workspace for the start (core/workspaces), as the draft's workspace row. */
  workspace?: { provider: string; inputs?: unknown };
  engine?: SessionEngine;
  expectReply?: boolean;
  replyTimeoutSecs?: number;
  /** rq-… id of a request the caller owes and hands to this task (session-requests.ts linkHandoffs). */
  handsOn?: string;
  callerSid?: string;
  startAttemptId?: string;
  source: string;
  /** Answer only once the session really started or failed (an engine switch must know the new id). */
  awaitStart?: boolean;
}

export interface SessionStartResult {
  taskId: string;
  title: string;
  sessionId?: string;
  requestId?: string;
  /** The requests this start handed on (`hands_on`), and the ones it could not, with why. */
  handedOn?: string[];
  handOnRefused?: { id: string; reason: string }[];
  started: boolean;
  /**
   * The start was accepted and its session is still spawning when this answer
   * went out (an ACP engine's provider takes longer than the response budget):
   * not a failure. `started` stays false until the process is up; read the task
   * again to see it. 2026-10-30: a bare `started: false` on an OpenCode start
   * read as "did not start" while the session was running.
   */
  starting?: boolean;
  /** The task's isolated workspace is being made; the session starts in it once it is ready. */
  preparing?: boolean;
  /** The task already had its one session: the message continued it (one-session-per-task.ts). */
  continued?: boolean;
  /**
   * The launch settings this start honoured, by request field name (effort,
   * create_cwd, workspace, ...). Absent on a server older than the field, which
   * is how a newer op tells the caller what an older Walnut ignored.
   */
  applied?: string[];
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
 * starts and a Personal AI ask's (Main's included: it is born walnut_agent) are
 * never limited, a start quoting the user's words runs under the higher ceiling,
 * and a caller that cannot be
 * resolved is not either (fail open: the limit is a brake on runaway fan-out,
 * not an access check).
 */
export async function admitStartWithinLimits(task: Task, callerSid: string | undefined, userRequest?: string): Promise<() => void> {
  const open = () => {};
  if (!callerSid) return open;
  const { resolveCallerPlacement } = await import('./caller-placement.js');
  const caller = await resolveCallerPlacement(callerSid).catch(() => ({ kind: 'unknown' as const }));
  if (caller.kind !== 'worker') return open;
  const { admitSubtaskStart, MIN_USER_REQUEST_CHARS } = await import('./subtask-limits.js');
  const quoted = (userRequest ?? '').trim();
  if (quoted && quoted.length < MIN_USER_REQUEST_CHARS) {
    throw new QuickStartError(`user_request must quote the user's own words asking for this start (${MIN_USER_REQUEST_CHARS} characters or more)`, 400);
  }
  if (quoted) {
    log.session.info('subtask start as the user asked', { taskId: task.id, parentId: caller.task.id, callerSid, userRequest: quoted.slice(0, 300) });
  }
  return admitSubtaskStart(caller.task.id, task.id, caller.task.title, { userAsked: !!quoted });
}

/**
 * A session's start of a lead that handed its project over is refused with the pointer, as a
 * message to it is (session-send-core.ts): a start would continue its one conversation, or begin
 * one, outside the send's check. The human, and the lead that took over, may start it.
 */
async function refuseStartOfRetiredLead(task: Task, callerSid: string | undefined): Promise<void> {
  if (task.org_role !== 'lead' || !callerSid?.trim()) return;
  const { resolveCaller } = await import('./session-send-core.js');
  const caller = await resolveCaller(callerSid);
  if (caller.kind !== 'session') return;
  const { retiredLeadRefusal } = await import('../org/retired-lead.js');
  const refusal = await retiredLeadRefusal(caller.record.taskId, task.id);
  if (refusal) throw new QuickStartError(refusal.message, 409, { code: 'lead_handed_over', ...refusal.detail });
}

/**
 * The engine a start that named none runs on: the ONE default engine
 * (Settings > Engines), as every other Walnut launch inherits it
 * (default-engine.ts). A task_start once always ran Claude here, so a Main on a
 * local model started leads that needed Claude Code. The host matters (an ACP
 * engine runs locally only), so the launch place is read first, but only when
 * the default is not Claude; a place that does not resolve leaves the default
 * engine and prepareLaunch reports the real error.
 */
async function inheritedEngine(task: Task, params: SessionStartParams): Promise<SessionEngine | undefined> {
  const { getConfig } = await import('../config-manager.js');
  const { resolveDefaultEngine } = await import('../agents/default-engine.js');
  // Effort and a model are Claude choices (validateLaunchChoices takes only Claude
  // model ids): a start that names either asked for Claude.
  if (params.effort || (params.model && params.model !== 'default')) return undefined;
  const config = await getConfig();
  if (normalizeEngine(resolveDefaultEngine(config)) === undefined) return undefined;
  const host = await resolveTaskLaunchReadOnly(task, params).then((l) => l.host, () => undefined);
  return normalizeEngine(resolveDefaultEngine(config, { host }));
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
  await refuseStartOfRetiredLead(task, params.callerSid);
  if (params.source !== 'engine-switch') {
    const { isSwitching } = await import('./engine-switch.js');
    if (isSwitching(task.id)) {
      throw new QuickStartError(`Task ${task.id} is switching engines right now. Continue it with task_send {"to":"${task.id}","text":"..."} in a moment.`, 409);
    }
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
  // Resolved before the duplicate check: on the normal path nothing awaits between
  // that check and taking the slot below, or two concurrent starts both get through.
  const engine = params.engine !== undefined ? normalizeEngine(params.engine) : await inheritedEngine(task, params);
  const pending = pendingStarts.get(task.id);
  if (pending !== undefined) throw alreadyStarted(task, pending);
  // A frozen human plan cannot authorize a later workspace launch with different settings.
  if (params.startAttemptId) requireFrozenWorkspaceReady(task, params);
  // A start that waits for a workspace replays these later; a bad one fails now.
  validateLaunchChoices(params);
  if (params.workspace) {
    const made = await startInNewWorkspace(task, params, params.workspace);
    if (made) return made;
  }
  if (willDeferStart(task, params)) {
    // The brake holds for a start that waits too (a preparing subtask counts as running).
    (await admitStartWithinLimits(task, params.callerSid, params.userRequest))();
    const deferred = await deferTaskStart(task, params);
    if (deferred) return { ...deferred, applied: pendingApplied(params) };
  }
  const sid = engineCaps(engine).idProvisioning === 'provider-issued' ? undefined : randomUUID();
  const runtimeId = sid ?? `acp-${randomUUID()}`;
  // Take the slot as soon as the task id is normalized; waiting on the disk or the runner must not allow a duplicate start.
  pendingStarts.set(task.id, sid ?? '');
  let releaseOnReturn = true;
  let releaseAdmission = () => {};
  try {
    releaseAdmission = await admitStartWithinLimits(task, params.callerSid, params.userRequest);
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
        ...(params.handsOn ? { handsOn: params.handsOn } : {}),
      });
      return {
        taskId: task.id, title: task.title, sessionId: sent.sessionId, requestId: sent.requestId, started: true, continued: true, applied: [],
        ...(sent.handedOn ? { handedOn: sent.handedOn } : {}), ...(sent.handOnRefused ? { handOnRefused: sent.handOnRefused } : {}),
      };
    }
    const launch = await prepareLaunch(task, { ...params, engine });
    let callerSessionId: string | undefined;
    // Its task: what that task still owes is handed on with this start's request.
    let callerTaskId: string | undefined;
    let requestId: string | undefined;
    if (params.handsOn !== undefined && !/^rq-[a-f0-9]{6,}$/.test(params.handsOn)) throw new QuickStartError('hands_on must be an rq-… id', 400);
    if (params.handsOn && params.expectReply === false) throw new QuickStartError('hands_on needs a reply request: leave expect_reply on', 400);
    // Resolved once: the reply request needs the caller, and so does the team's note of an ask.
    // A fire-and-forget start that names no caller resolves nothing.
    const { resolveCaller } = await import('./session-send-core.js');
    const caller = params.expectReply !== false || params.callerSid ? await resolveCaller(params.callerSid) : undefined;
    if (params.expectReply !== false) {
      if (!caller || caller.kind !== 'session') {
        if (params.expectReply === true || params.handsOn) throw new QuickStartError('expect_reply needs a session caller', 400);
      } else {
        callerSessionId = caller.record.claudeSessionId;
        callerTaskId = caller.record.taskId || undefined;
        // A start up the org reports, as a send does (reply-direction.ts): no request unless asked.
        if (params.expectReply === undefined && !params.handsOn) {
          const { goesUp } = await import('./reply-direction.js');
          if (await goesUp(callerTaskId, task.id).catch(() => false)) callerSessionId = undefined;
        }
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
    const result: SessionStartResult = { taskId: task.id, title: task.title, sessionId: sid, requestId, started: false,
      applied: appliedLaunchFields(task, params, launch) };
    const work = (async (): Promise<SessionStartResult> => {
      try {
        if (recovery && previous) {
          await updateSessionRecord(previous.claudeSessionId, { process_status: 'error', status_reason: 'api_error', status_changed_by: 'session-runner' });
          await detachTaskSession(task.id, previous.claudeSessionId, 'confirmed recovery cancelled the previous pending start');
        }
        if (callerSessionId) {
          const { createSessionRequest, buildReplyTrailer } = await import('../session-requests.js');
          const request = await createSessionRequest({
            fromSessionId: callerSessionId, ...(callerTaskId ? { fromTaskId: callerTaskId } : {}), ...(sid ? { toSessionId: sid } : {}),
            toTaskId: task.id, text: launch.message, replyTimeoutSecs: params.replyTimeoutSecs,
            implicit: params.expectReply === undefined,
            ...(params.handsOn ? { handsOn: [params.handsOn] } : {}),
          });
          if (request.carries?.length) result.handedOn = request.carries;
          if (request.handOnRefused?.length) result.handOnRefused = request.handOnRefused;
          requestId = request.id;
          result.requestId = request.id;
          launch.message += `\n${buildReplyTrailer(request)}`;
        }
        if (sid) {
          await createSessionRecord(sid, task.id, task.project ?? '', launch.cwd, {
            title: task.title, host: launch.host, mode: params.mode as SessionMode | undefined,
            ...(launch.effort ? { effort: launch.effort } : {}),
            engine, initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
          });
          seeded = true;
          await linkSession(task.id, sid);
          // A start is an ask too: one from outside the task's team is its VP's to know, as a
          // message is (team-asks.ts; org_send `task` starts a team task that has no session).
          if (caller?.kind === 'session' && launch.message) {
            const { buildPeerWrapper } = await import('../peers/peer-wrapper.js');
            const envelope = buildPeerWrapper(launch.message, {
              title: caller.record.title ?? '', shortId: caller.record.claudeSessionId.slice(0, 8),
              sessionId: caller.record.claudeSessionId, taskId: caller.record.taskId, host: 'local',
            });
            void import('../org/team-asks.js').then((m) => m.noteTeamAsk(sid, launch.message, envelope, 'peer')).catch(() => {});
          }
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
    if (params.awaitStart) return await work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<SessionStartResult>((resolve) => {
          timer = setTimeout(() => resolve({ ...result, starting: true }), START_RESPONSE_BUDGET_MS);
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

/** A start that names another engine, host or directory than the task's active
 *  conversation is refused: the engine changes inside the task (task_switch_engine);
 *  another host or directory is a new task (task_transfer). */
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
  const engineOnly = differs.length === 1 && differs[0].startsWith('engine ');
  throw new QuickStartError(
    `Task ${task.id} already has its active session (${differs.join(', ')}). `
    + (engineOnly
      ? `Continue it with task_send, or change its engine inside the task with task_switch_engine {"id":"${task.id}","engine":"${resolveEngine(params.engine)}","text":"..."}.`
      : `Continue it with task_send; work on another host or in another directory is a new task: task_transfer {"id":"${task.id}"}.`), 409);
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

/** The new-in-this-contract launch fields a fresh start honoured (SessionStartResult.applied). */
function appliedLaunchFields(task: Task, params: SessionStartParams, launch: { cwd: string; effort?: SessionEffort }): string[] {
  return [
    ...(launch.effort ? ['effort'] : []),
    ...(params.createCwd ? ['create_cwd'] : []),
    // Only when the session really runs in the task's workspace (a cwd outside it starts elsewhere).
    ...(params.workspace && workspaceCwdOf(task) && insideWorkspaceRoot(task.workspace!.root, launch.cwd) ? ['workspace'] : []),
  ];
}

function insideWorkspaceRoot(root: string | undefined, cwd: string): boolean {
  const r = (root ?? '').replace(/\/+$/, '');
  return !!r && (cwd === r || cwd.startsWith(`${r}/`));
}

/** What a start waiting for its workspace carries into the replay. */
function pendingApplied(params: SessionStartParams): string[] {
  return [...(params.workspace ? ['workspace'] : []), ...(params.effort ? ['effort'] : [])];
}

/**
 * task_start asking for an isolated workspace the task does not have yet: check
 * now everything the fresh start would check (the subtask brake, the task's one
 * session, a place a workspace can copy), then ask the host for it and leave the
 * start waiting in it. Null = the task already has a ready workspace or one on
 * the way, and the ordinary paths take the start.
 */
async function startInNewWorkspace(
  task: Task, params: SessionStartParams, workspace: NonNullable<SessionStartParams['workspace']>,
): Promise<SessionStartResult | null> {
  if (!workspace.provider) throw new QuickStartError('workspace needs a provider (workspace_providers lists them)', 400);
  if (task.workspace && (isLaunchReady(task.workspace) || task.workspace.state === 'creating')) return null;
  if (task.phase === 'COMPLETE') throw new QuickStartError(`Task ${task.id} is complete; a workspace start needs open work.`, 409);
  const records = await getSessionsForTask(task.id);
  const live = records.find((s) => !s.archived && LIVE_STATUSES.has(s.process_status));
  if (live) throw alreadyStarted(task, live.claudeSessionId);
  // One session per task: its conversation stays where it ran.
  const conversation = await taskConversation(task.id);
  if (conversation) {
    throw new QuickStartError(`Task ${task.id} already has its one session in ${conversation.cwd || 'its folder'}. `
      + `A workspace is for new work: task_create with workspace, or task_transfer {"id":"${task.id}"} to move this work.`, 409);
  }
  const place = await resolveTaskLaunchReadOnly(task, { ...params, workspace: undefined });
  if (place.createLocalDirectory) {
    throw new QuickStartError(`Task ${task.id} has no folder for a workspace to copy: pass cwd (an existing folder, usually a repository).`, 400);
  }
  (await admitStartWithinLimits(task, params.callerSid, params.userRequest))();
  const made = await requestTaskStartWorkspace(task, params, workspace, place);
  return made ? { ...made, applied: pendingApplied(params) } : null;
}

async function prepareLaunch(task: Task, params: SessionStartParams) {
  const launch = await resolveTaskLaunchReadOnly(task, params);
  if (params.createCwd && !launch.createLocalDirectory) {
    // Same sanitize rule as the quick-start route: this path may ride a daemon RPC.
    if (/[;&|`$(){}!<>]/.test(launch.cwd)) throw new QuickStartError('invalid characters in cwd', 400);
    const { ensureCwd } = await import('./ensure-cwd.js');
    await ensureCwd(launch.cwd, launch.host || undefined);
  }
  if (launch.createLocalDirectory) await mkdir(launch.cwd, { recursive: true });
  const { createLocalDirectory, ...resolved } = launch;
  return resolved;
}
