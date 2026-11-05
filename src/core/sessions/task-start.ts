import { randomUUID } from 'node:crypto';
import { requireFrozenWorkspaceReady, resolveTaskLaunchReadOnly, validateLaunchChoices } from './task-launch-plan.js';
import path from 'node:path';
import { getTask, linkSession, updateTaskRaw } from '../task-manager.js';
import { createSessionRecord, getSessionsForTask, updateSessionRecord } from '../session-tracker.js';
import { QuickStartError } from './quick-start.js';
import { continueTaskConversation, detachTaskSession, taskConversation } from './task-session-claim.js';
import { stableJson } from '../task-create-idempotency.js';
import type { Task, EngineFallbackNote, SessionEffort, SessionEngine, SessionMode, SessionProfile, SessionRecord } from '../types.js';
import type { FallbackDecision } from '../agents/fallback-engine.js';
import type { RouterArea } from '../router/areas.js';
import { isRouterAreaSession, routerAreaProfile, runsAreaProfile } from '../router/session-policy.js';
import { engineCaps, isAcpEngine, normalizeEngine, resolveEngine } from '../agents/engine-registry.js';
import { isDaemonCommandOutcomeUnknown } from '../../providers/delivery-failure.js';
import { log } from '../../logging/index.js';
import { withInboxStartAuthorization } from '../human-inbox/item-ledger.js';
import { deferTaskStart, requestTaskStartWorkspace, willDeferStart, workspaceCwdOf } from '../workspaces/launch.js';
import { isLaunchReady } from '../workspaces/decisions.js';

export interface SessionStartParams {
  taskIdPrefix: string;
  message?: string;
  /** Start with no first message and run no turn (an engine switch with nothing to say): never the
   *  task's description or a "Working on task" line, which would start its work again. */
  idle?: boolean;
  cwd?: string;
  host?: string;
  model?: string;
  mode?: string;
  /** Reasoning effort for the spawn (Claude Code's --effort). */
  effort?: SessionEffort;
  /** The user's own words asking for this start: it starts at once even on a full host (host-admission.ts). */
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
  /**
   * How long the answer waits for the session to come up (default START_RESPONSE_BUDGET_MS): an
   * agent's start answers once it really started or failed (2026-11-06, the user: a start is a
   * sync call, "if it did not start, it must be an error"). Counted from the start's first
   * step, placement included, so the caller's own op timeout never ends the call first.
   */
  answerWithinMs?: number;
  /** Walnut's own move of the task's work (an engine switch): never waits for a host slot. */
  ownMove?: boolean;
  /** A person's click through an automatic path (the Org page's Retry, Start now on a queued start): never waits. */
  byPerson?: boolean;
  /**
   * The queued entry this start runs (its `at`): the start is recorded only while that entry is
   * still queued, and takes it off the queue in the same write, so a cancel either comes first
   * (nothing starts) or finds it already starting (review round 5, Sol).
   */
  queuedAt?: string;
}

/** Restart recovery holds this session's start: it sends its first line again by itself. */
async function recoveryHolds(sessionId: string): Promise<boolean> {
  const { getSessionAutoRecover } = await import('../session-auto-recover.js');
  return !!getSessionAutoRecover()?.ownsStartDeath(sessionId);
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
  /** It started on the fallback engine: the default engine was out of usage (agents/fallback-engine.ts). */
  fallback?: EngineFallbackNote;
  /**
   * The launch settings this start honoured, by request field name (effort,
   * create_cwd, workspace, ...). Absent on a server older than the field, which
   * is how a newer op tells the caller what an older Walnut ignored.
   */
  applied?: string[];
  /** Where placement by load put this first start, and why (start-placement.ts). */
  placement?: import('./start-placement.js').StartPlacement;
  /**
   * The start waits for a free slot (host-admission.ts, start-queue.ts): its place in the
   * queue, the host it will run on, and why it waits. Walnut starts it by itself.
   */
  queued?: { position: number; host: string; reason: string; running: string[]; cap?: number };
  /** The task's session host could not be reached: the start moved the task (host-lost.ts). */
  hostLost?: { from: string; fromSessionId: string; error: string };
  /** The engine split chose this start's engine (core/agents/engine-split.ts), with the recent shares it saw. */
  enginePick?: import('../agents/engine-split.js').EnginePick;
}

export class SessionExistsError extends QuickStartError {
  constructor(
    message: string,
    public existingSessionId: string,
    /** The task, and the refusal's first sentence without the advice (a route adds its own: session-exists-hint.ts). */
    public taskId?: string,
    public head?: string,
  ) {
    super(message, 409);
    this.name = 'SessionExistsError';
  }
}

/** A queued start the user cancelled while it was being placed: nothing started (start-queue.ts drops it quietly). */
export class QueuedStartGoneError extends QuickStartError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'QueuedStartGoneError';
  }
}

const pendingStarts = new Map<string, string>();
const LIVE_STATUSES = new Set(['running', 'idle']);
const START_RESPONSE_BUDGET_MS = 5_000;

export function isTaskStarting(taskId: string): boolean {
  return pendingStarts.has(taskId);
}

/** How long a started session's slot stays held after its start settled (host-admission.ts). */
const SLOT_HOLD_MS = 60_000;

function alreadyStarted(task: Task, sid: string): SessionExistsError {
  const head = `Task "${task.title}" is already started or starting.`;
  return new SessionExistsError(`${head} Continue with task_send {"to":"${task.id}","text":"..."}.`, sid, task.id, head);
}

/**
 * `user_request` must be the user's own words: a token shorter than that is refused. It lets an
 * automatic start go ahead on a full host (sessions/host-admission.ts), as a person's own start does.
 */
export async function checkUserRequest(task: Task, callerSid: string | undefined, userRequest?: string): Promise<void> {
  const quoted = (userRequest ?? '').trim();
  if (!quoted || !callerSid) return;
  const { MIN_USER_REQUEST_CHARS } = await import('./subtask-limits.js');
  if (quoted.length < MIN_USER_REQUEST_CHARS) {
    throw new QuickStartError(`user_request must quote the user's own words asking for this start (${MIN_USER_REQUEST_CHARS} characters or more)`, 400);
  }
  log.session.info('start as the user asked', { taskId: task.id, callerSid, userRequest: quoted.slice(0, 300) });
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
 * The org is off (org/org-enabled.ts): Main or a VP is started only by a person's own start
 * (the user's first message in its chat). Walnut's and every agent's starts are refused.
 */
export async function refuseOrgStartWhileOff(task: Pick<Task, 'org_role'>, source: string | undefined, callerSid?: string): Promise<void> {
  const { isOrgNode, isOrgEnabled, ORG_OFF_MESSAGE } = await import('../org/org-enabled.js');
  if (!isOrgNode(task) || await isOrgEnabled()) return;
  // An engine switch only moves a conversation that already runs to another engine.
  if (source === 'engine-switch') return;
  const { isPersonSource } = await import('./send-sent-by.js');
  if (!callerSid?.trim() && isPersonSource(source)) return;
  throw new QuickStartError(ORG_OFF_MESSAGE, 409, { code: 'org_off' });
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
async function inheritedEngine(task: Task, params: SessionStartParams): Promise<{ engine: SessionEngine | undefined; fallback?: FallbackDecision }> {
  const { getConfig } = await import('../config-manager.js');
  const { resolveDefaultEngine } = await import('../agents/default-engine.js');
  // Effort and a model are Claude choices (validateLaunchChoices takes only Claude
  // model ids): a start that names either asked for Claude.
  if (params.effort || (params.model && params.model !== 'default')) return { engine: undefined };
  const config = await getConfig();
  const { fallbackSetting, resolveFallbackLaunch } = await import('../agents/fallback-engine.js');
  // The place is read only when it can change the answer: a default that is not Claude, or a
  // fallback whose use depends on the host's limit.
  if (normalizeEngine(resolveDefaultEngine(config)) === undefined && !fallbackSetting(config)) return { engine: undefined };
  const host = await resolveTaskLaunchReadOnly(task, params).then((l) => l.host, () => undefined);
  const engine = resolveDefaultEngine(config, { host });
  // A task that already has its conversation continues it on its own engine: nothing falls back.
  const fallback = await taskConversation(task.id).then((c) => c ? null : resolveFallbackLaunch(config, engine, host || undefined), () => null);
  return fallback ? { engine: normalizeEngine(fallback.engine), fallback } : { engine: normalizeEngine(engine) };
}

/** The task's note of why its session runs on the fallback engine: written at the start, and an
 *  older one taken off when this start runs on the default engine. */
async function noteEngineFallback(task: Task, note: EngineFallbackNote | undefined): Promise<void> {
  if (!note && !task.engine_fallback) return;
  try {
    await updateTaskRaw(task.id, { engine_fallback: note ?? null }, { source: 'task-start', emitEvent: true });
  } catch (error) {
    log.session.warn('fallback engine: the task note was not written', { taskId: task.id, error: String(error) });
  }
}

/**
 * The engine split's pick for this start, or null when it is off or does not apply. The pick
 * is kept on the task and counted at once, so a start that waits (the running-subtask queue,
 * a workspace being made) runs on it when it replays, and a retry after a failed start too.
 */
async function splitPick(task: Task, params: SessionStartParams) {
  // A task that holds a conversation continues it on the engine it has. A session whose spawn
  // failed before a turn is no conversation: its retry keeps the split's pick.
  if ((task.session_id || task.exec_session_id || task.session_ids?.length) && await taskConversation(task.id)) return null;
  const { splitApplies, splitBuilders, pickSplitEngine, recordPick } = await import('../agents/engine-split.js');
  const named = params.engine !== undefined || !!params.effort || (!!params.model && params.model !== 'default');
  // A second start of a task already starting is refused just after this (alreadyStarted): it never picks.
  if (pendingStarts.has(task.id)) return null;
  const { getConfig } = await import('../config-manager.js');
  const builders = splitBuilders(await getConfig());
  // Reused while the split still lists it: an entry since removed from the config (one that kept
  // failing, say) is not tried again on every retry.
  if (task.engine_pick && !named && builders.some((b) => b.key === task.engine_pick!.key)) return { ...task.engine_pick, reused: true };
  if (!splitApplies(task, params)) return null;
  if (builders.length < 2) return null;
  // Asked of the host this start would use; placement later moves only to a host that runs the engine.
  const host = await resolveTaskLaunchReadOnly(task, params).then((l) => l.host, () => undefined);
  const { hostEnginesAvailability } = await import('../agents/host-engines.js');
  let answer: Awaited<ReturnType<typeof hostEnginesAvailability>> | undefined;
  const pick = await pickSplitEngine(builders, async (id) => {
    // Dialed (still bounded by its 4 s deadline, then cached): a remote host with no cached answer would
    // otherwise leave every ACP entry out of the split.
    answer ??= await hostEnginesAvailability(host || '__local__');
    const row = answer[id];
    return row ? row.installed : null;
  }, Date.now(), task.id);
  if (!pick) return null;
  const kept = { key: pick.key, engine: pick.engine, ...(pick.model ? { model: pick.model } : {}), at: pick.at };
  try {
    // Written only while the task still holds the pick this start read: of two starts at once, the first pick stands.
    const stale = task.engine_pick?.key;
    const wrote = await updateTaskRaw(task.id, { engine_pick: kept }, { source: 'task-start', shouldUpdate: (current) => current.engine_pick?.key === stale });
    if (!wrote.changed) {
      const current = await getTask(task.id);
      if (current.engine_pick) return { ...current.engine_pick, reused: true };
    }
    await recordPick(pick.key, task.id, pick.at);
  } catch (err) {
    log.session.warn('engine split: could not keep the pick', { taskId: task.id, error: String(err) });
  }
  return pick;
}

/**
 * Start a session for a task. An automatic start that no host has room for is an error to its
 * caller, never a start left waiting (2026-11-06, the user: "if it did not start, it must be an
 * error ... if it fails, it fails, and the VP gets the message directly and can fix it"). A start
 * still in the old start queue (start-queue.ts) is dropped once the task started.
 */
export async function startSessionForTask(params: SessionStartParams): Promise<SessionStartResult> {
  let result: SessionStartResult;
  const picked: { split?: { key: string; engine: SessionEngine; model?: string } } = {};
  try {
    result = await startSessionForTaskNow(params, picked);
  } catch (err) {
    const { HostsFullError } = await import('./host-admission.js');
    if (err instanceof HostsFullError) {
      const d = err.detail;
      const why = `${d.label ?? d.host} has no room (${d.reason})`;
      // On the task, where task_get, the Board and its lead read it (review round 6: the reason
      // reached only the caller, and the task sat in To do saying nothing).
      await recordStartRefused(d.taskId, `Did not start: ${why}.`, d.host);
      const where = d.placement ? ` ${d.placement.charAt(0).toUpperCase()}${d.placement.slice(1)}.` : '';
      throw new HostsFullError(`Task ${d.taskId} did not start: ${why}.${where} Retry task_start with this id once one of your running `
        + `tasks ends; when the user asked for it now, pass user_request with their words, which starts it at once.`, d);
    }
    if (picked.split) await nameSplitPickInFailure(err, picked.split);
    throw err;
  }
  const { clearStartQueue } = await import('./start-queue.js');
  await clearStartQueue(result.taskId, 'started');
  return result;
}

/**
 * A start that the split put on an engine and that failed says so, and how to pick another: a
 * retry reuses the pick, so an engine that keeps failing would otherwise be retried forever.
 * Only a start whose engine this call took from the split (never a refusal before that).
 */
async function nameSplitPickInFailure(err: unknown, pick: { engine: SessionEngine; model?: string }): Promise<void> {
  if (!(err instanceof Error) || err.message.includes('engine split')) return;
  const { builderLabel, splitBuilders } = await import('../agents/engine-split.js');
  const { getConfig } = await import('../config-manager.js');
  // Name an engine other than the one that failed: the split's next other entry, else Claude Code.
  const failed = resolveEngine(pick.engine);
  const other = splitBuilders(await getConfig().catch(() => undefined)).map((b) => resolveEngine(b.engine)).find((e) => e !== failed)
    ?? (failed === 'claude' ? undefined : 'claude');
  // Every entry on the same engine (Claude Code on two models): another model is the way out.
  const hint = other ? `retry with engine "${other}" (or another) to choose a different one`
    : 'retry with model, for example "opus", or with another engine, to run it differently';
  try { err.message += ` (This start ran on ${builderLabel(pick)}, the engine split's pick for this task, and a retry uses it again: if that engine is what failed, ${hint}.)`; } catch { /* a read-only message */ }
}

/** A start no host had room for, as the task's last start (unless another start is under way). */
async function recordStartRefused(taskId: string, error: string, host: string): Promise<void> {
  await updateTaskRaw(taskId, (cur) => (cur.last_start?.state === 'starting' || pendingStarts.has(taskId) ? null : {
    last_start: { id: randomUUID(), at: new Date().toISOString(), state: 'failed' as const, error, host },
  }), { source: 'task-start' }).catch(() => null);
}

async function startSessionForTaskNow(params: SessionStartParams, picked: { split?: { key: string; engine: SessionEngine; model?: string } } = {}): Promise<SessionStartResult> {
  const answerBy = params.answerWithinMs !== undefined ? Date.now() + params.answerWithinMs : undefined;
  // `host: "@ios"` asks for what a host has (host-select.ts): resolved to one host before anything else reads it.
  params = await resolveHostSelector(params);
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
  await refuseOrgStartWhileOff(task, params.source, params.callerSid);
  // A router area task runs only in its isolated profile, on this machine, in its own directory.
  const area = await routerAreaStart(task, params);
  if (area) params = area.params;
  if (params.callerSid) {
    const { resolveCaller } = await import('./session-send-core.js');
    const caller = await resolveCaller(params.callerSid);
    if (caller.kind === 'session' && caller.record.taskId) {
      const { mayShareTaskContext } = await import('../router/context-sharing.js');
      if (!await mayShareTaskContext(caller.record.taskId, task.id)) throw areaRefusal('cross_area', 'A start cannot carry context across an incoming-item area. Nothing was started.');
    }
  }
  if (params.source !== 'engine-switch') {
    const { isSwitching } = await import('./engine-switch.js');
    if (isSwitching(task.id)) {
      throw new QuickStartError(`Task ${task.id} is switching engines right now. Continue it with task_send {"to":"${task.id}","text":"..."} in a moment.`, 409);
    }
  }
  // A start on another host for a task whose session's host cannot be reached: the move does it
  // (host-lost.ts), instead of a refusal that names a host nobody can reach.
  if (params.host !== undefined && !params.ownMove && !params.startAttemptId && params.source !== 'engine-switch') {
    const moved = await moveFromLostHost(task, params);
    if (moved) return moved;
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
  // An area task is always Claude Code: neither the engine split nor the install's default engine applies to it.
  // The engine split (engine-split.ts) speaks before the default engine; a named engine is the override.
  const split = !area && params.engine === undefined ? await splitPick(task, params) : null;
  if (split?.model) params = { ...params, model: split.model };
  const inherited = area || split ? undefined
    : params.engine !== undefined ? undefined : await inheritedEngine(task, params);
  const engine = params.engine !== undefined ? normalizeEngine(params.engine)
  : split ? normalizeEngine(split.engine) : inherited?.engine;
  // The fallback's model rides only this launch (prepareLaunch below): a start that waits for its
  // workspace or a slot replays the start as asked, and decides again then.
  const fallback = inherited?.fallback;
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
  if (!area && willDeferStart(task, params)) {
    // Its host's slot is taken when the workspace is ready and the start runs (manager.ts).
    await checkUserRequest(task, params.callerSid, params.userRequest);
    const deferred = await deferTaskStart(task, params);
    if (deferred) return { ...deferred, applied: pendingApplied(params) };
  }
  const sid = engineCaps(engine).idProvisioning === 'provider-issued' ? undefined : randomUUID();
  const runtimeId = sid ?? `acp-${randomUUID()}`;
  // Take the slot as soon as the task id is normalized; waiting on the disk or the runner must not allow a duplicate start.
  pendingStarts.set(task.id, sid ?? '');
  let releaseOnReturn = true;
  // The start's host slot (host-admission.ts): `holdMs` keeps it counted that long after.
  let releaseAdmission: (holdMs?: number) => void = () => {};
  // A spawn whose confirmation timed out still runs on: its slot is held until it settles.
  let spawnStill: Promise<unknown> | undefined;
  let spawnFailed = false;
  try {
    await checkUserRequest(task, params.callerSid, params.userRequest);
    const records = await getSessionsForTask(task.id);
    // Before anything below may cancel, retire, unarchive or resume one of them.
    if (area) refuseForeignAreaSessions(task, area.area, records);
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
      // A conversation with no live session resumes into a new process: an automatic one takes a
      // slot on its host like a first start, and fails when that host is full (review round 6, Sol).
      let resumeSlot: ((holdMs?: number) => void) | undefined;
      if (!LIVE_STATUSES.has(conversation.process_status)) {
        const { admitHostStart, isAutomaticStart } = await import('./host-admission.js');
        if (await isAutomaticStart(params)) resumeSlot = await admitHostStart(task.id, conversation.host, { automatic: true });
      }
      const sent = await continueTaskConversation(conversation, {
        text: params.message?.trim() || task.description || `Working on task: ${task.title}`,
        callerSid: params.callerSid, source: params.source, expectReply: params.expectReply, replyTimeoutSecs: params.replyTimeoutSecs,
        ...(params.handsOn ? { handsOn: params.handsOn } : {}),
      }).then((r) => { resumeSlot?.(SLOT_HOLD_MS); return r; }, (e: unknown) => { resumeSlot?.(0); throw e; });
      return {
        taskId: task.id, title: task.title, sessionId: sent.sessionId, requestId: sent.requestId, started: true, continued: true, applied: [],
        ...(sent.handedOn ? { handedOn: sent.handedOn } : {}), ...(sent.handOnRefused ? { handOnRefused: sent.handOnRefused } : {}),
      };
    }
    // The start's own checks first: nothing is placed or set up on a host for a start refused here.
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
    const launch = await prepareLaunch(task, { ...params, engine, ...(fallback?.model ? { model: fallback.model } : {}) }, area);
    // An engine switch's own start leaves the note to the switch: it clears it once it is done.
    if (params.source !== 'engine-switch') await noteEngineFallback(task, fallback?.note);
    // A first start that names no host goes where there is room (start-placement.ts); an area task
    // stays here. One that runs on the fallback stays where the default engine is out of usage: the
    // decision was its.
    // A slot on the host it runs on; an automatic start fails when that host is full (its caller
    // reads why). A move takes its slot on the target before anything is set up there (review
    // round 3: a refused start left a new clone behind on every try). Nothing waits here, so
    // nothing holds the task while a person's own start goes at once (review round 5).
    const { admitHostStart, isAutomaticStart, HostsFullError } = await import('./host-admission.js');
    const automatic = await isAutomaticStart(params);
    const slotOpts = { automatic };
    let moveSlot: ((holdMs?: number) => void) | undefined;
    const { placeStartByLoad } = await import('./start-placement.js');
    const placement = area || fallback ? undefined : await placeStartByLoad(task, params, launch, engine, {
      admit: async (host) => (moveSlot = await admitHostStart(task.id, host, slotOpts)),
    });
    if (placement?.moved && moveSlot) releaseAdmission = moveSlot;
    else {
      moveSlot?.(0);
      try {
        releaseAdmission = await admitHostStart(task.id, launch.host, slotOpts);
      } catch (err) {
        // Why no other host took it, in placement's words (review round 6: the answer said every
        // host was full when one had room but no checkout, or none was looked at).
        if (err instanceof HostsFullError) {
          err.detail.placement = placement && !placement.moved ? placement.reason
            : 'Walnut did not look for another host: this start keeps its host (it names its host or folder, or what it needs is only there)';
        }
        throw err;
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
    const claimed = await withInboxStartAuthorization(task.id, params.startAttemptId, () => updateTaskRaw(task.id, {
      last_start: attempt, ...(params.queuedAt ? { start_queue: null as never } : {}), }, {
      source: 'task-start', shouldUpdate: (current) => current.last_start?.id === task.last_start?.id
        && (!params.queuedAt || current.start_queue?.at === params.queuedAt)
        && (!params.startAttemptId || stableJson(current.last_start) === stableJson(task.last_start)
          && current.phase !== 'COMPLETE' && current.phase === task.phase && current.cwd === task.cwd && current.project === task.project),
    }));
    if (!claimed.changed) {
      if (params.queuedAt && !(await getTask(task.id).catch(() => null))?.start_queue) {
        throw new QueuedStartGoneError(`Task ${task.id}'s queued start was cancelled before it began; nothing started.`);
      }
      throw new QuickStartError(`Task ${task.id} changed before its start could be recorded. Read task_get before retrying.`, 409);
    }
    const settle = async (updates: Partial<NonNullable<Task['last_start']>>) => {
      try {
        // A failed start is counted for good: a later start replaces last_start, and the comparison
        // (engine-compare.ts) must still see that this task's engine once failed to start.
        await updateTaskRaw(task.id, (current) => ({ last_start: { ...attempt, ...updates },
          // Once per attempt: a failure is settled both where the launch rejects and in the outer catch.
          ...(updates.state === 'failed' && current.last_start?.state !== 'failed' ? { start_failures: (current.start_failures ?? 0) + 1 } : {}) }),
          { source: 'task-start', shouldUpdate: (current) => current.last_start?.id === attempt.id });
      } catch (error) {
        log.session.error('Failed to persist task start outcome', { taskId: task.id, attemptId: attempt.id, error: String(error) });
      }
    };
    let seeded = false;
    // Until the session starts on the message, no edge of the task speaks for its request.
    let delivered: (() => void) | undefined;
    const result: SessionStartResult = { taskId: task.id, title: task.title, sessionId: sid, requestId, started: false,
      applied: appliedLaunchFields(task, params, launch), ...(placement ? { placement } : {}),
      ...(fallback ? { fallback: fallback.note } : {}),
    ...(split ? { enginePick: split } : {}) };
    // From here the start is the engine's to make: a failure from now on may be the engine's own.
    if (split) picked.split = split;
    const work = (async (): Promise<SessionStartResult> => {
      try {
        if (recovery && previous) {
          await updateSessionRecord(previous.claudeSessionId, { process_status: 'error', status_reason: 'api_error', status_changed_by: 'session-runner' });
          await detachTaskSession(task.id, previous.claudeSessionId, 'confirmed recovery cancelled the previous pending start');
        }
        // The words as the starter wrote them: the session's first line frames them (send-frame.ts).
        const startBody = launch.message;
        let replyTrailer = '';
        if (callerSessionId) {
          const { createSessionRequest, buildReplyTrailer } = await import('../session-requests.js');
          const request = await createSessionRequest({
            fromSessionId: callerSessionId, ...(callerTaskId ? { fromTaskId: callerTaskId } : {}), ...(sid ? { toSessionId: sid } : {}),
            toTaskId: task.id, text: launch.message, replyTimeoutSecs: params.replyTimeoutSecs,
            implicit: params.expectReply === undefined, kind: 'start',
            ...(params.handsOn ? { handsOn: [params.handsOn] } : {}),
          });
          const { noteRequestDelivering } = await import('./undelivered-requests.js');
          delivered = noteRequestDelivering(request.id);
          if (request.carries?.length) result.handedOn = request.carries;
          if (request.handOnRefused?.length) result.handOnRefused = request.handOnRefused;
          requestId = request.id;
          result.requestId = request.id;
          replyTrailer = buildReplyTrailer(request);
          launch.message += `\n${replyTrailer}`;
        }
        if (sid) {
          await createSessionRecord(sid, task.id, task.project ?? '', launch.cwd, {
            title: task.title, host: launch.host, mode: launch.mode as SessionMode | undefined,
            ...(launch.effort ? { effort: launch.effort } : {}),
            ...(launch.profile ? { profile: launch.profile } : {}),
            engine, initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
          });
          seeded = true;
          await linkSession(task.id, sid);
          // A start is an ask too: one from outside the task's team is its VP's to know, as a
          // message is (team-asks.ts; org_send `task` starts a team task that has no session).
          if (!area && caller?.kind === 'session' && launch.message) {
            const { buildPeerWrapper } = await import('../peers/peer-wrapper.js');
            const { senderTitleOf } = await import('../peers/sender-name.js');
            const envelope = buildPeerWrapper(launch.message, {
              title: await senderTitleOf(caller.record), shortId: caller.record.claudeSessionId.slice(0, 8),
              sessionId: caller.record.claudeSessionId, taskId: caller.record.taskId, host: 'local',
            });
            void import('../org/team-asks.js').then((m) => m.noteTeamAsk(sid, launch.message, envelope, 'peer')).catch(() => {});
          }
        }
        const { sessionRunner } = await import('../../providers/claude-code-session.js');
        // The first line says who started the task: a session's peer note, or Walnut's, never a person's typing.
        const { frameStartText } = await import('./send-frame.js');
        const { frameAsWalnut, readsAsPerson, framingCallerOf } = await import('./send-frame.js');
        // An engine switch attributes its own first line (engine-switch.ts prepare): the person's words as
        // theirs, an agent's framed, and Walnut's carried context as a hint block a display takes off.
        let firstMessage = params.source === 'engine-switch' ? startBody : frameStartText(startBody, {
          source: params.source, ...(params.callerSid ? { callerSid: params.callerSid } : {}),
          ...(caller?.kind === 'session' ? { caller: await framingCallerOf(caller.record) } : {}), ...(requestId ? { requestId } : {}),
        }) + (replyTrailer ? `\n${replyTrailer}` : '');
        // The reply trailer after an envelope that is not the request's own reads as typed words: frame the whole.
        if (replyTrailer && readsAsPerson(firstMessage)) firstMessage = frameAsWalnut(firstMessage, params.source);
        // The first message carries what an App gave the task (its state, an AI-only brief) as every
        // later one does: it does not pass the queue (app-state.ts; the brief leads the line). A
        // provider-issued id (an ACP engine) is known only once it started: told under it then. A
        // start with no message (an idle engine switch) runs no turn: the next message carries it.
        const { pendingAppState } = await import('./app-state.js');
        const appState = !area && firstMessage.trim() ? await pendingAppState(runtimeId, firstMessage, Date.now(), { taskId: task.id }) : null;
        if (appState) firstMessage = `${appState.text}\n\n${firstMessage}`;
        const starting = spawnStill = sessionRunner.startSession({ ...launch, message: firstMessage, namingMessage: startBody, attributed: true, preassignedSessionId: sid, runtimeId: sid ? undefined : runtimeId, waitForSpawn: true }).then(async (ready) => {
          appState?.markTold(ready.claudeSessionId);
          await settle({ state: 'started', session_id: ready.claudeSessionId });
          return { ...result, sessionId: ready.claudeSessionId, started: true };
        }, async (error) => {
          appState?.release();
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
          delivered?.();
        }
      } catch (err) {
        delivered?.();
        const message = err instanceof Error ? err.message : String(err);
        // A timeout does not prove the process never started; keep the start record and let the normal state reconciliation path confirm it.
        const uncertain = isDaemonCommandOutcomeUnknown(err);
        // Its host could not be reached and restart recovery sends the first line again
        // once it answers (sessions/start-recovery.ts): a start under way, not a failure
        // for its caller or its asker. The runner took it on before it reported the failure.
        const recovering = !uncertain && !!sid && await recoveryHolds(sid);
        if (recovering) {
          log.session.info('task start: its host could not be reached; restart recovery starts it again', { taskId: task.id, sessionId: sid, error: message.slice(0, 200) });
          await settle({ state: 'unconfirmed', error: message });
          // Not left at awaiting_spawn: the session did not start, and its host is the reason.
          if (seeded) {
            await updateSessionRecord(sid, {
              process_status: 'error', errorMessage: message,
              status_reason: 'remote_unreachable', status_changed_by: 'session-runner', errorKind: 'infra' as const,
            }).catch(() => {});
          }
          return { ...result, sessionId: sid, started: false, starting: true };
        }
        if (!uncertain) spawnFailed = true;
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
        delivered?.();
        pendingStarts.delete(task.id);
        // Review round 3 (Sol): a started session is counted by its record from now on, and its
        // slot stays held a minute so a record not yet marked running is never counted as none;
        // a failed spawn gives it back now; one whose answer timed out keeps it until the spawn
        // settles (at most 10 minutes), as the process may still come up.
        if (spawnFailed || !spawnStill) releaseAdmission(0);
        else {
          const release = releaseAdmission;
          const cap = setTimeout(() => release(0), 10 * 60_000);
          cap.unref?.();
          // A spawn whose own answer was lost (the link dropped, the daemon's reply timed out)
          // may still come up: it keeps the slot until the cap (review round 4, Sol).
          void spawnStill.then(() => { clearTimeout(cap); release(SLOT_HOLD_MS); }, (e: unknown) => {
            if (isDaemonCommandOutcomeUnknown(e)) return;
            clearTimeout(cap);
            release(0);
          });
        }
      }
    })();
    releaseOnReturn = false;
    if (params.awaitStart) return await work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<SessionStartResult>((resolve) => {
          timer = setTimeout(() => resolve({ ...result, starting: true }), answerBy !== undefined ? Math.max(0, answerBy - Date.now()) : START_RESPONSE_BUDGET_MS);
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

/**
 * The task's session (a live one, else its conversation) runs on another host than the start
 * names, and that host is gone (host-lost.ts hostGone): task_move's path carries the task
 * there, the old session stopped here, and the start's own message then goes to the new
 * session the usual way (a reply request, hands_on, the task's description when it names no
 * message). Null when there is no such session, its host is not gone, or it runs on an ACP
 * engine (whose worker could not be stopped once its host is back): the usual refusal.
 */
export async function moveFromLostHost(task: Task, params: SessionStartParams): Promise<SessionStartResult | null> {
  const records = await getSessionsForTask(task.id);
  const anchor = records.find((s) => !s.archived && LIVE_STATUSES.has(s.process_status)) ?? await taskConversation(task.id).catch(() => undefined);
  if (!anchor || sameHost(params.host, anchor.host) || isAcpEngine(anchor.engine)) return null;
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
  if (getConnectedDaemonConnection(anchor.host || '__local__')) return null;
  const { hostGone } = await import('./host-lost.js');
  const gone = await hostGone(anchor.host, { target: params.host });
  if (!gone.gone) {
    if (!gone.unreachable) return null;
    log.session.info('task start: the session host does not answer, but it is not gone', { taskId: task.id, from: anchor.host, why: gone.why });
    throw new QuickStartError(`This task's session runs on ${anchor.host}, which does not answer, and it cannot move to ${params.host || 'this Mac'} yet: ${gone.why}.`, 409, { code: 'host_unreachable', host: anchor.host });
  }
  log.session.warn('task start: the task\'s session host is gone; moving it instead', { taskId: task.id, from: anchor.host, to: params.host, error: gone.error });
  const { requestEngineSwitch, EngineSwitchError } = await import('./engine-switch.js');
  let moved: Awaited<ReturnType<typeof requestEngineSwitch>>;
  try {
    // No message: the carried context waits for the start's message, sent below.
    moved = await requestEngineSwitch({
      taskId: task.id, engine: (params.engine !== undefined ? normalizeEngine(params.engine) : undefined) ?? resolveEngine(anchor.engine),
      host: params.host, message: '', source: params.source,
      ...(params.callerSid ? { callerSid: params.callerSid } : {}), ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort } : {}), ...(params.userRequest ? { userWords: params.userRequest } : {}),
    });
  } catch (err) {
    if (err instanceof EngineSwitchError) throw new QuickStartError(err.message, err.status, { error: err.message, code: err.code });
    throw err;
  }
  const hostLost = { from: anchor.host || '__local__', fromSessionId: anchor.claudeSessionId, error: gone.error };
  const record = moved.state === 'done' && moved.sessionId ? (await getSessionsForTask(task.id)).find((s) => s.claudeSessionId === moved.sessionId) : undefined;
  if (!record) {
    // The host answered after all (the move went the usual way and waits on its turn there), or
    // another move was under way: the message has nowhere to go yet, so it is refused, never dropped.
    throw new QuickStartError(`The task is moving off ${anchor.host} (${moved.state}); this start's message was not sent. Send it once the move is done (task_get shows it).`, 409, { code: 'move_under_way' });
  }
  const sent = await continueTaskConversation(record, {
    text: params.message?.trim() || task.description || `Working on task: ${task.title}`,
    callerSid: params.callerSid, source: params.source, expectReply: params.expectReply, replyTimeoutSecs: params.replyTimeoutSecs,
    ...(params.handsOn ? { handsOn: params.handsOn } : {}),
  });
  return {
    taskId: task.id, title: task.title, sessionId: sent.sessionId, requestId: sent.requestId, started: true, continued: true, applied: [], hostLost,
    ...(sent.handedOn ? { handedOn: sent.handedOn } : {}), ...(sent.handOnRefused ? { handOnRefused: sent.handOnRefused } : {}),
  };
}
const sameHost = (a?: string, b?: string) => (LOCAL_ALIASES.has(a ?? '') && LOCAL_ALIASES.has(b ?? '')) || a === b;

/** The start with a `@tag` host resolved to a host; a refusal is a 409 that says which hosts have it. */
async function resolveHostSelector(params: SessionStartParams): Promise<SessionStartParams> {
  const { parseHostSelector, resolveHostParam, HostSelectorError } = await import('../hosts/host-select.js');
  try {
    if (!parseHostSelector(params.host)) return params;
    const prefer: Array<{ host: string; why: string }> = [];
    // The task's own conversation first: a start on another host would be refused as a move.
    const task = await getTask(params.taskIdPrefix).catch(() => null);
    const conversation = task ? await taskConversation(task.id).catch(() => undefined) : undefined;
    if (conversation) prefer.push({ host: conversation.host || '__local__', why: 'is where this task already runs' });
    if (params.callerSid) {
      const { resolveCaller } = await import('./session-send-core.js');
      const caller = await resolveCaller(params.callerSid).catch(() => null);
      if (caller?.kind === 'session') prefer.push({ host: caller.record.host || '__local__', why: 'is where the caller runs' });
    }
    const { host, pick } = await resolveHostParam(params.host, { prefer });
    log.session.info('host selector resolved', { selector: params.host, host, reason: pick?.reason, taskId: params.taskIdPrefix });
    return { ...params, host };
  } catch (err) {
    if (err instanceof HostSelectorError) throw new QuickStartError(err.message, err.code === 'bad_selector' ? 400 : 409, { code: err.code });
    throw err;
  }
}

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
      : params.host !== undefined && !sameHost(params.host, conversation.host)
        ? `Continue it with task_send, or move it there in one step (same task, its conversation and its own work): task_move {"id":"${task.id}","host":"${params.host || 'local'}"}.`
        : `Continue it with task_send; work in another directory is a new task: task_transfer {"id":"${task.id}"}.`), 409);
}

/** The start's host is gone (host-lost.ts hostGone), and the start's session was stopped here as lost. */
async function stoppedAsLost(record: { claudeSessionId: string }, host: string): Promise<boolean> {
  const { hostGone } = await import('./host-lost.js');
  if (!(await hostGone(host)).gone) return false;
  const { terminateSession } = await import('./session-lifecycle.js');
  const stopped = await terminateSession(record.claudeSessionId, { force: true }).catch(() => null);
  return !!stopped?.hostLost;
}

async function cancelUnconfirmedStart(task: Task, record?: Awaited<ReturnType<typeof getSessionsForTask>>[number], keepRecord = false): Promise<void> {
  const attempt = task.last_start;
  const runtimeId = attempt?.runtime_id || attempt?.session_id || record?.claudeSessionId;
  if (!runtimeId) throw new QuickStartError(`Task ${task.id} has an unconfirmed start without a runtime identity. Read task_get; another start cannot be safely issued.`, 409);
  const host = attempt?.host || record?.host || '__local__';
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
  const reconcile = async () => {
    let conn = getConnectedDaemonConnection(host);
    if (!conn) conn = await (await import('../hosts/link.js')).link(host);
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
    // The host does not answer: that start is stopped here, and its host ends it if it ever
    // came up (host-lost.ts), so this start goes ahead instead of waiting for a host that is gone.
    if (record && !keepRecord && await stoppedAsLost(record, host)) {
      await updateSessionRecord(record.claudeSessionId, { process_status: 'error', status_reason: 'api_error', status_changed_by: 'session-runner' });
      return;
    }
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
  return (await recordedPlace(task))?.cwd;
}

/**
 * recordedCwd with the task that recorded it, and the host when the record names one
 * (a ready workspace). Which host a plain recorded cwd lives on: launch-place.ts.
 */
export async function recordedPlace(task: Pick<Task, 'id' | 'project' | 'cwd' | 'parent_task_id' | 'workspace'>): Promise<{ cwd: string; ownerId: string; host?: string } | undefined> {
  const project = (task.project ?? '').trim().toLowerCase();
  let current: Pick<Task, 'id' | 'project' | 'cwd' | 'parent_task_id' | 'workspace'> | undefined = task;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if ((current.project ?? '').trim().toLowerCase() !== project) return undefined;
    // A ready isolated workspace is where the task's work lives (core/workspaces).
    const ws = workspaceCwdOf(current);
    if (ws) return { cwd: ws, ownerId: current.id, host: current.workspace!.host };
    if (current.cwd) return { cwd: current.cwd, ownerId: current.id };
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
 * now everything the fresh start would check (the user's words, the task's one
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
  if (place.createTaskDir) {
    throw new QuickStartError(`Task ${task.id} has no folder of its own for a workspace to copy (only its task directory): pass cwd (an existing folder, usually a repository).`, 400);
  }
  await checkUserRequest(task, params.callerSid, params.userRequest);
  const made = await requestTaskStartWorkspace(task, params, workspace, place);
  return made ? { ...made, applied: pendingApplied(params) } : null;
}

/** A start of a task in a router area: the area, the isolated profile, and the start pinned to its place. */
interface RouterAreaStart {
  area: RouterArea;
  profile: SessionProfile;
  cwd: string;
  params: SessionStartParams;
}

const areaRefusal = (code: string, message: string, status = 409) => new QuickStartError(message, status, { code, error: message });

/**
 * Router areas (router/areas.ts) keep Personal and Work apart: their tasks read outside content the
 * ordinary global toolbelt must never see. Such a task starts only on Claude Code, in dontAsk mode,
 * with the area's own profile (router/session-policy.ts), on this machine (a slim profile is local
 * only), in its own task directory; any other engine, mode, host, folder or workspace is refused,
 * never silently replaced. Null for a task in no area: its start is unchanged.
 */
async function routerAreaStart(task: Task, params: SessionStartParams): Promise<RouterAreaStart | null> {
  const { readRouterAreas, taskArea } = await import('../router/areas.js');
  const { WALNUT_HOME } = await import('../../constants.js');
  let file: Awaited<ReturnType<typeof readRouterAreas>>;
  try {
    file = await readRouterAreas(WALNUT_HOME);
  } catch (err) {
    if (!task.router_area_id && task.org_role !== 'router') return null;
    throw areaRefusal('router_areas_unreadable', `This task's router area could not be read: ${err instanceof Error ? err.message : String(err)}`, 503);
  }
  const area = taskArea(file, task.id);
  if (task.router_area_id && task.router_area_id !== area?.id) throw areaRefusal('router_area_mismatch', 'The task and its configured area disagree. Nothing was started.');
  if (!area && (task.router_area_id || task.org_role === 'router')) throw areaRefusal('router_unassigned', 'This scoped task has no matching area. Finish its router setup before starting it.');
  if (!area) return null;
  if (task.router_area_id !== area.id || task.source !== 'local'
    || file.routers.some((router) => router.taskId === task.id) !== (task.org_role === 'router')) {
    throw areaRefusal('router_area_mismatch', 'The task does not match its configured local area role. Nothing was started.');
  }
  if (area.host !== '__local__') {
    throw areaRefusal('area_host_unsupported', `Task ${task.id} belongs to router area ${area.id} on host "${area.host}"; an isolated area session runs only on this machine for now.`);
  }
  if (params.engine !== undefined && !runsAreaProfile(params.engine)) {
    throw areaRefusal('area_engine_unsupported', `Task ${task.id} belongs to router area ${area.id}, whose sessions run only on Claude Code.`);
  }
  if (params.mode !== undefined && params.mode !== 'dontAsk') {
    throw areaRefusal('area_mode_unsupported', `Task ${task.id} belongs to router area ${area.id}, whose sessions run only in dontAsk mode.`);
  }
  if (params.host !== undefined && !LOCAL_ALIASES.has(params.host)) {
    throw areaRefusal('area_host_unsupported', `Task ${task.id} belongs to router area ${area.id} and runs only on this machine, not on "${params.host}".`);
  }
  if (params.workspace || params.createCwd) {
    throw areaRefusal('area_place_fixed', `Task ${task.id} belongs to router area ${area.id} and runs only in its own task directory.`);
  }
  const { link } = await import('../hosts/link.js');
  if (!(await link('__local__')).hasCapability('walnut-mcp-v1')) {
    throw areaRefusal('area_tools_unavailable', 'This daemon cannot serve isolated routing tools. Update Walnut before starting this area conversation.');
  }
  const { taskDirForHost } = await import('./task-dir-place.js');
  const cwd = await taskDirForHost(task.id, '__local__');
  if (!cwd) throw areaRefusal('area_place_fixed', `Task ${task.id} has no task directory on this machine.`, 500);
  if (params.cwd !== undefined && path.resolve(params.cwd) !== path.resolve(cwd)) {
    throw areaRefusal('area_place_fixed', `Task ${task.id} belongs to router area ${area.id} and runs only in its own task directory, not in ${params.cwd}.`);
  }
  return {
    area, profile: routerAreaProfile(area.id, file.routers.some((router) => router.taskId === task.id) ? 'router' : 'work'), cwd,
    params: { ...params, engine: undefined, mode: 'dontAsk', host: '__local__', cwd },
  };
}

/**
 * An area task's sessions must all carry its isolated profile. One that does not (made before the
 * task joined the area, or with another profile) has seen context outside the area: it is never
 * continued, resumed, retired or replaced by a start; the refusal leaves it as it is.
 */
function refuseForeignAreaSessions(task: Task, area: RouterArea, records: SessionRecord[]): void {
  const foreign = records.find((r) => !isRouterAreaSession(r, area, task.org_role === 'router' ? 'router' : 'work'));
  if (!foreign) return;
  throw new QuickStartError(
    `Task ${task.id} belongs to router area ${area.id}, but its session ${foreign.claudeSessionId} was not started isolated in that area. `
    + 'It is left untouched; route the area\'s work through a new task in the area.', 409,
    { code: 'area_session_not_isolated', error: 'area_session_not_isolated', sessionId: foreign.claudeSessionId, areaId: area.id });
}

async function prepareLaunch(task: Task, params: SessionStartParams, area?: RouterAreaStart | null) {
  if (area) {
    // Its own task directory on this machine and its profile, whatever the task or project recorded.
    const { taskId, project, model, effort, message } = await resolveTaskLaunchReadOnly(task, { ...params, workspace: undefined });
    const { ensureTaskDirOnHost } = await import('./task-dir-place.js');
    const made = await ensureTaskDirOnHost(task.id, '__local__');
    if ('error' in made) throw new QuickStartError(`Task ${task.id} could not make its task directory (${made.error}).`, made.status);
    if (path.resolve(made.path) !== path.resolve(area.cwd)) throw areaRefusal('area_place_fixed', `Task ${task.id}'s task directory moved while it started; retry.`);
    return {
      taskId, project, cwd: area.cwd, host: '', model, mode: 'dontAsk' as const, ...(effort ? { effort } : {}),
      engine: undefined, message, profile: area.profile,
    };
  }
  const launch = await resolveTaskLaunchReadOnly(task, params);
  if (params.createCwd && !launch.createTaskDir) {
    // Same sanitize rule as the quick-start route: this path may ride a daemon RPC.
    if (/[;&|`$(){}!<>]/.test(launch.cwd)) throw new QuickStartError('invalid characters in cwd', 400);
    const { ensureCwd } = await import('./ensure-cwd.js');
    await ensureCwd(launch.cwd, launch.host || undefined);
  }
  if (launch.createTaskDir) {
    // A named host with no folder of its own for this task: its task directory there.
    const { ensureTaskDirOnHost } = await import('./task-dir-place.js');
    const made = await ensureTaskDirOnHost(task.id, launch.host || undefined);
    if ('error' in made) throw new QuickStartError(`Task ${task.id} needs a cwd on host "${launch.host}": its task directory there could not be made (${made.error}). Pass cwd.`, made.status);
  }
  const { createTaskDir, ...resolved } = launch;
  return { ...resolved, profile: undefined as SessionProfile | undefined };
}
