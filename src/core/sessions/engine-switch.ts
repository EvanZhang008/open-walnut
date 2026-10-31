/**
 * Switch a task's engine inside the task (2026-10-29, the user: "我们可以一个task切切过去，
 * 再切回来 ... 用户非常无感"). A task holds one ACTIVE session at a time; a switch
 * ends it and starts a NEW session on the other engine, in the same task, the
 * same directory and the same task directory. Switching back to an engine the
 * task used before resumes that earlier session with only the turns it missed,
 * while its history is still a prefix of the task's conversation (keeping its
 * prompt cache, engine-switch-resume.ts); otherwise it also starts a new session.
 *
 *   1. ask:     a pick made while a turn runs waits for that turn to end
 *               (`engine_switch.state = 'pending'`, engine-switch-watch.ts), then runs
 *   2. read:    the old session's active context, the harness's way (engine-switch-context.ts)
 *   3. write:   the task's full transcript (every session, oldest first) on the target host
 *   4. stay:    the new session runs on the old one's host, in its directory: a switch
 *               never moves the work (an engine that host cannot run is refused;
 *               moving to another host is task_transfer)
 *   5. retire:  the old session is archived `engine_switched:<engine>` BEFORE its process
 *               stops, so no stop path treats it as the task's session (no hand-back, no
 *               settled request, no notice to the leader); its queued rows are held
 *   6. start:   the new session gets the carried context as an `engine-switch` hint block
 *               (display shows the user's words) and the user's message
 *   7. follow:  open requests and the held queue rows move to the new session
 * A failed start puts everything back: the old session is the task's session again.
 *
 * A MOVE (task_move, 2026-10-31, the user: "it is overloaded why u keep put it in mac?")
 * is the same switch with another host: `state.move`, `to.host` the target, the engine
 * kept unless one is named. The old session is retired FIRST, so nothing changes the
 * work while it is copied; then the task's own work (transfer/task-work.ts) is packed
 * on the old host and set up under the task directory on the new one, and the new
 * session starts there with the carried context. A failed copy or start restores the
 * old session as above; the old host's copies are never touched.
 */
import { randomUUID } from 'node:crypto';
import { log } from '../../logging/index.js';
import type { EngineSwitchState, SessionEffort, SessionEngine, SessionMode, SessionRecord, Task } from '../types.js';
import { engineCaps, resolveEngine } from '../agents/engine-registry.js';
import { engineHostBlocker, LOCAL_HOST, normalizeHost } from '../transfer/planner.js';
import { engineSwitchedReason, isSupersededSession } from './engine-switch-marker.js';
import { contextFingerprint, planResume, resumeEarlier } from './engine-switch-resume.js';
import { hostPath, putQueuedRows, takeQueuedRows, writeTaskTranscript, type HeldRow } from './engine-switch-io.js';
import {
  CARRY_WINDOW_SHARE, ENGINE_SWITCH_HINT, readActiveContext, renderCarriedContext, targetWindowTokens,
} from './engine-switch-context.js';

export class EngineSwitchError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'EngineSwitchError';
  }
}

export interface EngineSwitchRequest {
  taskId: string;
  engine: SessionEngine;
  /** Another host than the session's: a move (task_move). Unset = the session's host. */
  host?: string;
  /** The user's words asking for it, quoted by the agent that passes them on. */
  userWords?: string;
  model?: string;
  effort?: SessionEffort;
  permissionMode?: SessionMode;
  /** The text the new session receives after the carried context (image refs and reference cards included). */
  message: string;
  /** What the user typed, when it differs from `message`. */
  displayText?: string;
  /** The session asking (an agent), or undefined for a person. */
  callerSid?: string;
  source: string;
  /** Answer once the switch is checked and under way, not when the new session is up. */
  detach?: boolean;
}

export interface EngineSwitchResult {
  state: 'pending' | 'switching' | 'done';
  taskId: string;
  switchId: string;
  fromSessionId?: string;
  sessionId?: string;
  engine: SessionEngine;
  host: string;
  carriedTurns?: number;
  trimmedTurns?: number;
  transcriptPath?: string;
  /** The task's earlier session on that engine was resumed with the turns it missed. */
  resumed?: boolean;
  /** A move: the host it left, and what of the work came along (one line per piece). */
  fromHost?: string;
  moved?: string[];
}

const LIVE = new Set(['running', 'idle']);
/** taskId → the switch running now and the session it replaces. */
const inFlight = new Map<string, { from: string; work: Promise<EngineSwitchResult>; maxMs: number }>();
/** A move copies and sets up repositories (a clone can take minutes); a message for the
 *  session it replaces waits that long for it rather than reaching the stopped one. */
const MOVE_WAIT_MS = 15 * 60_000;
const SWITCH_WAIT_MS = 120_000;

function by(callerSid: string | undefined, callerTaskId: string | undefined): string {
  return callerSid ? `task:${callerTaskId ?? 'unknown'}` : 'human';
}

/**
 * The session is in a turn, or a message for it is queued and not yet delivered (a
 * stopped session a switch back just resumed has its message waiting while the CLI
 * starts): a switch waits for that turn.
 */
export async function sessionBusy(rec: Pick<SessionRecord, 'claudeSessionId' | 'process_status'>): Promise<boolean> {
  if (rec.process_status === 'running') return true;
  const { getStore } = await import('../session-queue-store.js');
  const rows = (await getStore().catch(() => null))?.queues[rec.claudeSessionId] ?? [];
  return rows.some((r) => r.status === 'pending' || r.status === 'processing');
}

/**
 * Where the new session runs: always the old session's host (2026-10-30, the user:
 * "default it only switch to the same machine"). An engine that host cannot run is
 * refused; moving the work to another host is a separate step (task_transfer).
 */
export async function switchHostBlocker(host: string, engine: SessionEngine): Promise<string | null> {
  const rule = engineHostBlocker(engine, host);
  if (rule) return rule;
  const { hostEngineAvailability } = await import('../agents/host-engines.js');
  const availability = await hostEngineAvailability(host, engine).catch(() => null);
  // A probe still running is no answer: the start itself says why it cannot run.
  if (availability && !availability.installed && !/^(still checking availability|availability check unavailable)$/.test(availability.reason ?? '')) {
    return `${engineCaps(engine).displayName} is not available on ${host === LOCAL_HOST ? 'this Mac' : host}${availability.reason ? `: ${availability.reason}` : ''}`;
  }
  return null;
}

/**
 * Ask for a switch. Runs it now when the task's session is not in a turn;
 * otherwise records it as pending, and the turn's end runs it (engine-switch-watch.ts).
 * A task with no conversation yet just starts on the engine.
 */
export async function requestEngineSwitch(req: EngineSwitchRequest): Promise<EngineSwitchResult> {
  const engine = resolveEngine(req.engine);
  const tm = await import('../task-manager.js');
  const task = await tm.getTask(req.taskId).catch((err: unknown) => {
    throw new EngineSwitchError(err instanceof Error ? err.message : String(err), 404, 'task_not_found');
  });
  if (!req.message.trim()) throw new EngineSwitchError('An engine switch needs the message the new session starts with', 400, 'message_required');
  if (isSwitching(task.id)) {
    throw new EngineSwitchError('This task is switching engines right now; send your message once the new session is up', 409, 'switch_in_progress');
  }
  const { taskConversation } = await import('./task-session-claim.js');
  const old = await taskConversation(task.id);
  const switchId = `es-${randomUUID()}`;
  if (!old) {
    const { startSessionForTask } = await import('./task-start.js');
    const started = await startSessionForTask({
      taskIdPrefix: task.id, message: req.message, engine, model: req.model, effort: req.effort, mode: req.permissionMode,
      callerSid: req.callerSid, expectReply: false, source: req.source,
      ...(req.host !== undefined ? { host: normalizeHost(req.host) } : {}),
    });
    return { state: 'done', taskId: task.id, switchId, sessionId: started.sessionId, engine, host: normalizeHost(req.host) };
  }
  const oldHost = normalizeHost(old.host);
  const host = req.host !== undefined ? normalizeHost(req.host) : oldHost;
  const move = host !== oldHost;
  if (!move && req.host !== undefined && resolveEngine(old.engine) === engine) {
    throw new EngineSwitchError(`This task already runs on ${host === LOCAL_HOST ? 'this Mac' : host}`, 400, 'same_host');
  }
  if (!move && resolveEngine(old.engine) === engine) {
    throw new EngineSwitchError(`This task already runs on ${engineCaps(engine).displayName}; change its model in the session instead`, 400, 'same_engine');
  }
  if (move) {
    const { getConfig } = await import('../config-manager.js');
    const entry = host === LOCAL_HOST ? null : (await getConfig()).hosts?.[host] as { enabled?: boolean } | undefined;
    if (host !== LOCAL_HOST && (!entry || entry.enabled === false)) throw new EngineSwitchError(`Unknown host: ${host}`, 400, 'unknown_host');
    if (task.workspace && task.workspace.state === 'ready') {
      throw new EngineSwitchError('This task works in an isolated workspace, which stays on its host; task_transfer moves it as a new task', 409, 'workspace_task');
    }
  }
  const blocker = await switchHostBlocker(host, engine);
  if (blocker) {
    throw new EngineSwitchError(move ? `${blocker}.` : `${blocker}. A switch keeps the task on its host; to move the work, use task_move.`, 409, 'engine_not_on_host');
  }
  const waiting = task.engine_switch?.state === 'pending' ? task.engine_switch : undefined;
  const busy = await sessionBusy(old);
  if (waiting && waiting.from_session_id === old.claudeSessionId && busy) {
    throw new EngineSwitchError(
      `A switch to ${engineCaps(waiting.to.engine).displayName} already waits for this turn to end; cancel it first`, 409, 'switch_pending');
  }
  if (waiting) {
    // A pending pick whose turn is long over (or whose session is no longer the task's): this one replaces it.
    await tm.updateTaskRaw(task.id, (cur) => (cur.engine_switch?.id === waiting.id && cur.engine_switch.state === 'pending'
      ? { engine_switch: { ...cur.engine_switch, state: 'failed', error: 'replaced by a newer switch' } } : null), { source: 'engine-switch', emitEvent: true });
  }
  const { resolveCaller } = await import('./session-send-core.js');
  const caller = await resolveCaller(req.callerSid);
  const state: EngineSwitchState = {
    id: switchId, state: 'pending', at: new Date().toISOString(),
    from_session_id: old.claudeSessionId, ...(old.engine ? { from_engine: old.engine } : {}),
    to: {
      engine, ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}),
      ...(req.permissionMode ? { permission_mode: req.permissionMode } : {}), host,
    },
    ...(move ? { move: true, from_host: oldHost, ...(old.cwd ? { from_cwd: old.cwd } : {}) } : {}),
    ...(req.userWords?.trim() ? { user_words: req.userWords.trim().slice(0, 2000) } : {}),
    message: req.message, ...(req.displayText && req.displayText !== req.message ? { display_text: req.displayText } : {}),
    by: by(req.callerSid, caller.kind === 'session' ? caller.record.taskId : undefined),
  };
  if (busy) {
    await tm.updateTaskRaw(task.id, { engine_switch: state }, { source: 'engine-switch', emitEvent: true });
    const { watchPendingSwitch } = await import('./engine-switch-watch.js');
    watchPendingSwitch(task.id, old.claudeSessionId);
    log.session.info('engine switch: pending until the turn ends', { taskId: task.id, switchId, from: old.claudeSessionId, to: engine });
    return { state: 'pending', taskId: task.id, switchId, fromSessionId: old.claudeSessionId, engine, host };
  }
  if (req.detach) {
    void runEngineSwitch(task.id, state).catch(() => { /* recorded on the task (engine_switch.error) */ });
    return { state: 'switching', taskId: task.id, switchId, fromSessionId: old.claudeSessionId, engine, host };
  }
  return runEngineSwitch(task.id, state);
}

/**
 * Cancel a pending switch, or let go of the message a failed one still holds. With
 * `deliver`, that message goes to the task's current session instead.
 */
export async function cancelPendingSwitch(taskId: string, opts: { deliver?: boolean } = {}): Promise<{ cancelled: boolean; delivered?: boolean }> {
  const tm = await import('../task-manager.js');
  let held: EngineSwitchState | undefined;
  await tm.updateTaskRaw(taskId, (cur) => {
    const sw = cur.engine_switch;
    if (sw?.state === 'pending') {
      held = sw;
      return { engine_switch: { ...sw, state: 'failed', error: 'cancelled', message: undefined, display_text: undefined } };
    }
    if (sw?.state === 'failed' && sw.message) {
      held = sw;
      return { engine_switch: { ...sw, message: undefined, display_text: undefined } };
    }
    return null;
  }, { source: 'engine-switch', emitEvent: true });
  if (!held) return { cancelled: false };
  if (opts.deliver && held.message) {
    const { sendMessageToSession } = await import('../session-message-queue.js');
    await sendMessageToSession(held.from_session_id, held.display_text ?? held.message, {
      source: 'ui', taskId, enqueueMessage: held.message,
    });
    return { cancelled: true, delivered: true };
  }
  return { cancelled: true };
}

/** Run a recorded (or fresh) switch now. One at a time per task. */
export function runEngineSwitch(taskId: string, state: EngineSwitchState): Promise<EngineSwitchResult> {
  const running = inFlight.get(taskId);
  if (running) return running.work;
  const work = execute(taskId, state).finally(() => inFlight.delete(taskId));
  inFlight.set(taskId, { from: state.from_session_id, work, maxMs: state.move ? MOVE_WAIT_MS : SWITCH_WAIT_MS });
  return work;
}

export function isSwitching(taskId: string): boolean {
  return inFlight.has(taskId);
}

/** The task whose running switch replaces `sessionId`, if any: that session takes no new turn meanwhile. */
export function switchingFrom(sessionId: string): string | undefined {
  for (const [taskId, sw] of inFlight) if (sw.from === sessionId) return taskId;
  return undefined;
}

/**
 * The session a message for `sessionId` belongs in: itself, or, for a session an
 * engine switch replaced, its task's active session (waiting for a switch still
 * starting). Never throws: an unknown answer keeps `sessionId`.
 */
export async function activeSessionFor(sessionId: string): Promise<string> {
  try {
    // A message for the session a running switch replaces waits for the switch:
    // it then belongs in the new session (or in this one again, when the start failed).
    const switching = switchingFrom(sessionId);
    if (switching) await awaitSwitch(switching);
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sessionId);
    if (!rec || !isSupersededSession(rec) || !rec.taskId) return sessionId;
    await awaitSwitch(rec.taskId);
    const { taskConversation } = await import('./task-session-claim.js');
    const active = await taskConversation(rec.taskId);
    if (active && active.claudeSessionId !== sessionId) {
      log.session.info('engine switch: a message for the replaced session goes to the active one', { from: sessionId, to: active.claudeSessionId, taskId: rec.taskId });
      return active.claudeSessionId;
    }
  } catch { /* keep the address */ }
  return sessionId;
}

/** Wait (bounded) for a switch of `taskId` in flight. True when one was running. */
export async function awaitSwitch(taskId: string, maxMs?: number): Promise<boolean> {
  const running = inFlight.get(taskId);
  if (!running) return false;
  const ms = maxMs ?? running.maxMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([running.work.catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, ms); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
  return true;
}

async function execute(taskId: string, state: EngineSwitchState): Promise<EngineSwitchResult> {
  const tm = await import('../task-manager.js');
  const tracker = await import('../session-tracker.js');
  const task = await tm.getTask(taskId);
  const old = await tracker.getSessionByClaudeId(state.from_session_id);
  if (!old || isSupersededSession(old)) {
    const err = new EngineSwitchError('The session this switch started from is gone or already replaced', 409, 'switch_stale');
    await fail(taskId, state, err);
    throw err;
  }
  const engine = resolveEngine(state.to.engine);
  // The old session's host, except for a move (task_move); a pending switch an older
  // Walnut recorded with `confirm_move` stays put.
  const host = state.move ? normalizeHost(state.to.host) : normalizeHost(old.host);
  if (await sessionBusy(old)) {
    // A turn started after the check (a trigger, a peer): the switch waits for it.
    let parked = false;
    await tm.updateTaskRaw(taskId, (cur) => {
      if (!mayRun(cur.engine_switch, state)) return null;
      parked = true;
      return { engine_switch: { ...state, state: 'pending' } };
    }, { source: 'engine-switch', emitEvent: true });
    if (!parked) throw new EngineSwitchError('This switch was cancelled or replaced', 409, 'switch_cancelled');
    const { watchPendingSwitch } = await import('./engine-switch-watch.js');
    watchPendingSwitch(taskId, old.claudeSessionId);
    return { state: 'pending', taskId, switchId: state.id, fromSessionId: old.claudeSessionId, engine, host };
  }
  let claimed = false;
  await tm.updateTaskRaw(taskId, (cur) => {
    if (!mayRun(cur.engine_switch, state)) return null;
    claimed = true;
    return { engine_switch: { ...state, state: 'switching' } };
  }, { source: 'engine-switch', emitEvent: true });
  // Cancelled while it waited (or a newer pick took over): nothing changes.
  if (!claimed) throw new EngineSwitchError('This switch was cancelled or replaced', 409, 'switch_cancelled');
  log.session.info('engine switch: starting', { taskId, switchId: state.id, from: old.claudeSessionId, fromEngine: resolveEngine(old.engine), to: engine, host });

  const rows = await tracker.getSessionsForTask(taskId);
  // Retire the old session: from here its stop is history, not the task's.
  const retire = async (left?: { fingerprint: string; messages: number }): Promise<HeldRow[]> => {
    const oldWasLive = LIVE.has(old.process_status);
    await tracker.updateSessionRecord(old.claudeSessionId, {
      archived: true, archive_reason: engineSwitchedReason(engine), ...(left ? { leftContext: { ...left, at: new Date().toISOString() } } : {}),
    });
    const taken = await takeQueuedRows(old.claudeSessionId);
    if (taken.length > 0) {
      await tm.updateTaskRaw(taskId, (cur) => (cur.engine_switch?.id === state.id ? { engine_switch: { ...cur.engine_switch, held_rows: taken } } : null), { source: 'engine-switch', emitEvent: true }).catch(() => {});
    }
    if (oldWasLive) {
      try {
        const { terminateSession } = await import('./session-lifecycle.js');
        await terminateSession(old.claudeSessionId, { force: true });
      } catch (err) {
        log.session.warn('engine switch: stopping the old session failed (its process ends with its idle reap)', {
          taskId, sessionId: old.claudeSessionId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return taken;
  };
  let prepared: Awaited<ReturnType<typeof prepare>>;
  let held: HeldRow[];
  if (!state.move) {
    // Read and render before anything changes: a failure here leaves the task as it was.
    try {
      prepared = await prepare(task, old, rows, state, engine, host);
    } catch (err) {
      await fail(taskId, state, err);
      throw err;
    }
    held = await retire(prepared.left);
  } else {
    // A move stops the old session before its work is copied, so nothing changes under the copy.
    held = await retire();
    try {
      prepared = await prepare(task, old, rows, state, engine, host);
    } catch (err) {
      await restore(taskId, old, undefined, new Date().toISOString(), held);
      await fail(taskId, state, err);
      throw err instanceof EngineSwitchError ? err : new EngineSwitchError(
        `The move to ${host === LOCAL_HOST ? 'this Mac' : host} did not happen: ${err instanceof Error ? err.message : String(err)}. The task stays where it was.`,
        typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 502,
        typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'move_failed');
    }
  }

  if (prepared.resume) {
    const resumed = await resumeEarlier(taskId, state, old, prepared.resume, prepared.transcriptPath, held).catch(async (err: unknown) => {
      log.session.warn('engine switch: resuming the earlier session failed, starting a new one', {
        taskId, sessionId: prepared.resume!.prev.claudeSessionId, error: err instanceof Error ? err.message : String(err),
      });
      await tracker.updateSessionRecord(prepared.resume!.prev.claudeSessionId, {
        archived: true, archive_reason: prepared.resume!.prev.archive_reason, supersededBy: prepared.resume!.prev.supersededBy,
        resumedBySwitch: prepared.resume!.prev.resumedBySwitch,
      }).catch(() => {});
      return null;
    });
    if (resumed) return resumed;
  }

  let sessionId: string | undefined;
  const startedAt = new Date().toISOString();
  try {
    const { startSessionForTask } = await import('./task-start.js');
    const started = await startSessionForTask({
      taskIdPrefix: taskId, message: prepared.message, cwd: prepared.cwd, host: host === LOCAL_HOST ? '__local__' : host,
      engine, ...(state.to.model ? { model: state.to.model } : {}), ...(state.to.effort ? { effort: state.to.effort } : {}),
      ...(prepared.mode ? { mode: prepared.mode } : {}), expectReply: false, source: 'engine-switch', awaitStart: true,
    });
    sessionId = started.sessionId;
    if (!sessionId || started.started === false) throw new Error('the new session did not confirm its start');
  } catch (err) {
    // A start that did not confirm may still have spawned (a daemon timeout): stop it
    // before the old session is the task's again, so two CLIs never share the work.
    if (sessionId) {
      try {
        const { terminateSession } = await import('./session-lifecycle.js');
        await terminateSession(sessionId, { force: true });
      } catch { /* not running */ }
    }
    await restore(taskId, old, sessionId, startedAt, held);
    await fail(taskId, state, err);
    throw err instanceof EngineSwitchError ? err : new EngineSwitchError(state.move
      ? `The new session on ${host === LOCAL_HOST ? 'this Mac' : host} did not start: ${err instanceof Error ? err.message : String(err)}. The task stays on ${normalizeHost(old.host) === LOCAL_HOST ? 'this Mac' : old.host}; the copied work is kept at ${prepared.cwd ?? 'its task directory'}.`
      : `The switch to ${engineCaps(engine).displayName} did not start: ${err instanceof Error ? err.message : String(err)}. The task stays on ${engineCaps(old.engine).displayName}.`,
      502, 'start_failed');
  }

  const at = new Date().toISOString();
  await tracker.updateSessionRecord(sessionId, {
    engineSwitch: {
      fromSessionId: old.claudeSessionId, ...(old.engine ? { fromEngine: old.engine } : {}),
      ...((old.cliModel || old.model || old.acpModel) ? { fromModel: old.cliModel || old.model || old.acpModel } : {}),
      at, carriedTurns: prepared.carried.carriedTurns, trimmedTurns: prepared.carried.trimmedTurns,
      compacted: prepared.compacted, ...(prepared.transcriptPath ? { transcriptPath: prepared.transcriptPath } : {}),
      ...(state.move ? { fromHost: normalizeHost(old.host), ...(old.cwd ? { fromCwd: old.cwd } : {}) } : {}),
    },
  }).catch(() => {});
  await tracker.updateSessionRecord(old.claudeSessionId, { supersededBy: sessionId }).catch(() => {});
  const { retargetRequestsToSession } = await import('../session-requests.js');
  const movedRequests = await retargetRequestsToSession(old.claudeSessionId, sessionId).catch(() => 0);
  await putQueuedRows(sessionId, held);
  await tm.updateTaskRaw(taskId, {
    engine_switch: {
      ...state, state: 'done', message: undefined, display_text: undefined, held_rows: undefined, session_id: sessionId,
      carried_turns: prepared.carried.carriedTurns, trimmed_turns: prepared.carried.trimmedTurns,
      ...(prepared.transcriptPath ? { transcript_path: prepared.transcriptPath } : {}),
      ...(prepared.moved ? { moved: prepared.moved } : {}),
    },
  }, { source: 'engine-switch', emitEvent: true });
  log.session.info('engine switch: done', {
    taskId, switchId: state.id, from: old.claudeSessionId, sessionId, engine, host,
    carriedTurns: prepared.carried.carriedTurns, trimmedTurns: prepared.carried.trimmedTurns,
    tokens: prepared.carried.tokens, budget: prepared.carried.budgetTokens, source: prepared.source, movedRequests, heldRows: held.length,
  });
  return {
    state: 'done', taskId, switchId: state.id, fromSessionId: old.claudeSessionId, sessionId, engine, host,
    carriedTurns: prepared.carried.carriedTurns, trimmedTurns: prepared.carried.trimmedTurns,
    ...(prepared.transcriptPath ? { transcriptPath: prepared.transcriptPath } : {}),
    ...(state.move ? { fromHost: normalizeHost(old.host), moved: prepared.moved ?? [] } : {}),
  };
}

/** Everything the new session needs, computed while nothing has changed yet. */
async function prepare(task: Task, old: SessionRecord, rows: SessionRecord[], state: EngineSwitchState, engine: SessionEngine, host: string) {
  const oldHost = normalizeHost(old.host);
  let cwd = old.cwd ?? task.cwd ?? undefined;
  let moveMeta: NonNullable<Parameters<typeof renderCarriedContext>[1]['move']> | undefined;
  let moved: string[] | undefined;
  if (state.move) {
    // The task's own work, packed on the old host and set up under its task directory here.
    const { moveTaskWork } = await import('../transfer/task-work.js');
    const work = await moveTaskWork({ task, session: old, sourceHost: oldHost, targetHost: host, moveId: `xf-${state.id.replace(/^es-/, '')}` });
    cwd = work.cwd;
    moved = work.summary;
    const label = (h: string) => (h === LOCAL_HOST ? 'this Mac' : h);
    moveMeta = {
      fromHost: label(oldHost), toHost: label(host), ...(old.cwd ? { fromCwd: old.cwd } : {}), cwd: work.cwd,
      work: work.summary, steps: work.pieces.filter((p) => p.steps).map((p) => `### ${p.dest}\n${p.steps}`),
    };
    log.session.info('task move: work moved', { taskId: task.id, switchId: state.id, from: oldHost, to: host, cwd: work.cwd, pieces: work.pieces.length, applied: work.pieces.filter((p) => p.applied).length });
  }

  const ctx = await readActiveContext(old);
  const left = await contextFingerprint(ctx.messages);
  const transcriptPath = await writeTaskTranscript(task, rows, host, state.id).catch((err: unknown) => {
    log.session.warn('engine switch: the full transcript could not be written', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  });
  const window = await targetWindowTokens(engine, state.to.model, host, rows);
  // Back to an engine the task used before: resume that session when its history is still a
  // prefix. Never on a move: the work was set up anew in another place.
  const planned = state.move ? { reason: 'a move starts a new session' } : await planResume({
    active: old, activeCtx: ctx, rows, engine, host, cwd, model: state.to.model, windowTokens: window,
    ...(transcriptPath ? { transcriptPath } : {}),
  }).catch((err: unknown) => ({ reason: `the check failed: ${err instanceof Error ? err.message : String(err)}` }));
  log.session.info(`engine switch: ${'plan' in planned && planned.plan ? 'resumes the earlier session' : 'starts a new session'}`, {
    taskId: task.id, switchId: state.id, engine, reason: planned.reason,
    ...('plan' in planned && planned.plan ? { sessionId: planned.plan.prev.claudeSessionId, missedTurns: planned.plan.missedTurns, tokens: planned.plan.tokens } : {}),
  });
  const resume = 'plan' in planned ? planned.plan : undefined;
  const carried = await renderCarriedContext(ctx.messages, {
    fromEngine: resolveEngine(old.engine), fromModel: old.cliModel || old.model || old.acpModel || undefined,
    toEngine: engine, ...(transcriptPath ? { transcriptPath } : {}),
    ...(ctx.rawTranscriptPath ? { rawTranscriptPath: hostPath(ctx.rawTranscriptPath, oldHost, host) } : {}), compacted: ctx.compacted,
    ...(moveMeta ? { move: moveMeta } : {}),
  }, Math.floor(window * CARRY_WINDOW_SHARE));
  const { composeHinted, renderHintBlock } = await import('../hints/hint-format.js');
  const blocks = [renderHintBlock(ENGINE_SWITCH_HINT, carried.text)];
  if (carried.trimmedTurns > 0) {
    // The user is told in the session (a system row) as well as the model in its context.
    log.session.info('engine switch: carried context trimmed to fit the target window', {
      taskId: task.id, trimmedTurns: carried.trimmedTurns, budgetTokens: carried.budgetTokens,
    });
  }
  const message = composeHinted(state.message ?? '', { before: blocks, after: [] });
  const mode = state.to.permission_mode ?? old.mode;
  return {
    message, cwd, carried, transcriptPath, compacted: ctx.compacted, source: ctx.source, mode, left, moved,
    ...(resume ? { resume: { ...resume, message: composeHinted(state.message ?? '', { before: [renderHintBlock(ENGINE_SWITCH_HINT, resume.text)], after: [] }) } } : {}),
  };
}

/** A switch that did not start: the old session is the task's session again, with its rows. */
async function restore(taskId: string, old: SessionRecord, newSid: string | undefined, since: string, held: HeldRow[]): Promise<void> {
  const tracker = await import('../session-tracker.js');
  const { detachTaskSession } = await import('./task-session-claim.js');
  // A row the failed start made for the task would block the old one from being its session again.
  for (const r of await tracker.getSessionsForTask(taskId)) {
    if (r.claudeSessionId !== old.claudeSessionId && !isSupersededSession(r) && (r.claudeSessionId === newSid || (r.startedAt ?? '') >= since)) {
      await detachTaskSession(taskId, r.claudeSessionId, 'engine switch did not start').catch(() => {});
    }
  }
  await tracker.updateSessionRecord(old.claudeSessionId, { archived: false, archive_reason: undefined }).catch((err: unknown) => log.session.warn('engine switch: restoring the old session failed', {
    taskId, sessionId: old.claudeSessionId, error: err instanceof Error ? err.message : String(err),
  }));
  const tm = await import('../task-manager.js');
  await tm.linkSession(taskId, old.claudeSessionId).catch((err: unknown) => log.session.warn('engine switch: relinking the old session failed', {
    taskId, sessionId: old.claudeSessionId, error: err instanceof Error ? err.message : String(err),
  }));
  await putQueuedRows(old.claudeSessionId, held);
}

/**
 * Whether `state` may take the task's switch slot: it is the recorded pending pick,
 * or a fresh one while no other switch waits or runs. A cancelled or replaced pick never runs.
 */
function mayRun(cur: EngineSwitchState | undefined, state: EngineSwitchState): boolean {
  if (!cur) return true;
  if (cur.id === state.id) return cur.state === 'pending';
  return cur.state !== 'pending' && cur.state !== 'switching';
}

/** Record a failure of THIS switch (never over a newer one). Its message stays, so the user can still send it. */
async function fail(taskId: string, state: EngineSwitchState, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log.session.warn('engine switch failed; the task stays on its session', { taskId, switchId: state.id, error: message });
  const tm = await import('../task-manager.js');
  await tm.updateTaskRaw(taskId, (cur) => {
    const sw = cur.engine_switch;
    if (sw && sw.id !== state.id && (sw.state === 'pending' || sw.state === 'switching')) return null;
    return { engine_switch: { ...state, state: 'failed', error: message, held_rows: undefined } };
  }, { source: 'engine-switch', emitEvent: true }).catch(() => {});
}
