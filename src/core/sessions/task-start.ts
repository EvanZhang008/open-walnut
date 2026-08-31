/**
 * session_start core — start a NEW session for an EXISTING task.
 *
 * One job, maximum clarity: task_create records, session_start executes,
 * session_send talks to what's already running. A task whose session is still
 * live gets a 409 pointing at session_send instead of a second session (the
 * 1-task-1-session slot rule), and the old resume-into-live-session behavior
 * moved to session_send's task-handle resolution — this file no longer decides
 * between "start" and "resume".
 *
 * The session id is minted HERE (claude engine) and rides SESSION_START as
 * preassignedSessionId, so the caller gets the id back in the same response —
 * the old bus-only path returned nothing and the asker had to poll. Codex
 * sessions derive their own ids from the ACP adapter, so those return without
 * one (same contract as POST /sessions).
 *
 * expect_reply: registers a session-request row (see session-requests.ts) and
 * appends the reply trailer to the first message, so a freshly started session
 * knows exactly how to report back to whoever started it.
 */

import { randomUUID } from 'node:crypto';
import { getTask } from '../task-manager.js';
import { getSessionsForTask } from '../session-tracker.js';
import { bus, EventNames } from '../event-bus.js';
import { QuickStartError } from './quick-start.js';
import { resolveModelSwitchValue, VALID_SESSION_MODEL_IDS, VALID_SESSION_MODE_IDS } from '../types.js';
import type { SessionEngine } from '../types.js';
import { engineCaps, normalizeEngine } from '../agents/engine-registry.js';

export interface SessionStartParams {
  /** Task id or unique id prefix. */
  taskIdPrefix: string;
  /** First message. Defaults to a sentence naming the task. */
  message?: string;
  /** Absolute working directory override; the runner resolves task.cwd →
   *  parent chain → project default when omitted. */
  cwd?: string;
  /** Execution host alias (config.hosts); omit for the primary box. */
  host?: string;
  model?: string;
  mode?: string;
  engine?: SessionEngine;
  /** Register a reply request routed back to the caller session. */
  expectReply?: boolean;
  replyTimeoutSecs?: number;
  /** Transport-stamped caller sid (required for expectReply). */
  callerSid?: string;
  /** Event-bus source tag, e.g. 'cli' | 'api-v1'. */
  source: string;
}

export interface SessionStartResult {
  taskId: string;
  title: string;
  /** Present for the claude engine (preassigned); codex derives its own. */
  sessionId?: string;
  /** Present when expectReply registered a request. */
  requestId?: string;
}

/** 409 carrier so the route can put the live session id in the response body. */
export class SessionExistsError extends QuickStartError {
  constructor(message: string, public existingSessionId: string) {
    super(message, 409);
    this.name = 'SessionExistsError';
  }
}

/** Live enough that a second session would violate the 1-task-1-session slot. */
const LIVE_STATUSES = new Set(['running', 'idle']);

export async function startSessionForTask(params: SessionStartParams): Promise<SessionStartResult> {
  const { taskIdPrefix, source } = params;

  let task;
  try {
    task = await getTask(taskIdPrefix);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No task found matching')) {
      throw new QuickStartError(`No task found matching "${taskIdPrefix}"`, 404);
    }
    if (msg.includes('Ambiguous ID prefix')) throw new QuickStartError(msg, 400);
    throw err;
  }

  const sessions = await getSessionsForTask(task.id);
  const live = sessions.find((s) => !s.archived && LIVE_STATUSES.has(s.process_status));
  if (live) {
    throw new SessionExistsError(
      `task "${task.title}" already has a live session (${live.claudeSessionId.slice(0, 8)}) — `
      + `send into it with session_send {"to":"${live.claudeSessionId.slice(0, 8)}",...}`,
      live.claudeSessionId,
    );
  }

  // Shape checks mirror the launch route's vocabulary (400s, exact messages
  // are not frozen here — this surface is agent-facing, not the phone's).
  if (params.cwd !== undefined && !params.cwd.startsWith('/')) {
    throw new QuickStartError('cwd must be an absolute path', 400);
  }
  if (params.mode !== undefined && !VALID_SESSION_MODE_IDS.has(params.mode)) {
    throw new QuickStartError(
      `Invalid mode: ${params.mode}. Must be one of: ${[...VALID_SESSION_MODE_IDS].join(', ')}`, 400);
  }
  let model: string | undefined;
  if (typeof params.model === 'string' && params.model && params.model !== 'default') {
    const resolved = resolveModelSwitchValue(params.model);
    if (!resolved) {
      throw new QuickStartError(
        `Invalid model: ${params.model}. Use one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}`, 400);
    }
    model = resolved;
  }
  if (params.host !== undefined && params.host !== '') {
    const { getConfig } = await import('../config-manager.js');
    const entry = (await getConfig()).hosts?.[params.host];
    if (!entry || entry.enabled === false) {
      throw new QuickStartError(`Unknown host: ${params.host}`, 400);
    }
  }

  let message = params.message?.trim() || `Working on task: ${task.title}`;
  const engine = normalizeEngine(params.engine);
  const preassignedSessionId = engineCaps(engine).idProvisioning === 'provider-issued' ? undefined : randomUUID();

  let requestId: string | undefined;
  if (params.expectReply) {
    const { resolveCaller } = await import('./session-send-core.js');
    const caller = await resolveCaller(params.callerSid);
    if (caller.kind !== 'session') {
      throw new QuickStartError(
        'expect_reply needs a session caller — a reply can only be routed back to a tracked session', 400);
    }
    const { createSessionRequest, buildReplyTrailer } = await import('../session-requests.js');
    const request = await createSessionRequest({
      fromSessionId: caller.record.claudeSessionId,
      ...(preassignedSessionId ? { toSessionId: preassignedSessionId } : {}),
      toTaskId: task.id,
      text: message,
      replyTimeoutSecs: params.replyTimeoutSecs,
    });
    requestId = request.id;
    message = `${message}\n${buildReplyTrailer(request)}`;
  }

  bus.emit(EventNames.SESSION_START, {
    taskId: task.id,
    message,
    project: task.project,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.host ? { host: params.host } : {}),
    ...(params.mode ? { mode: params.mode } : {}),
    ...(model ? { model } : {}),
    ...(engine ? { engine } : {}),
    ...(preassignedSessionId ? { preassignedSessionId } : {}),
  }, ['session-runner'], { source });

  return {
    taskId: task.id,
    title: task.title,
    ...(preassignedSessionId ? { sessionId: preassignedSessionId } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
