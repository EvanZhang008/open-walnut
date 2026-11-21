/**
 * The journal v2 kind `session` on the Mac (docs/plan/walnut-replica-servers-impl.md
 * section 8, WP12): a new Ask Walnut session a host started while this Mac was away.
 * offline-handover.ts drains it after the ask's `task-create` (the same journal, in
 * order) and then has the connection look at the session as a reconnect does, so the
 * live CLI is attached (the rescue).
 *
 * Adoption here:
 *   - the session record, with host = the drained host's alias, its cwd, mode, model and
 *     effort, and the persona this Mac renders for that agent WITHOUT a walnut MCP mount:
 *     like every session this Mac runs on a remote host, its walnut tools are the `walnut`
 *     CLI there, which the host's daemon points at its gateway socket (a mount of this
 *     Mac's execPath does not exist there, and one of the host's app would talk to that
 *     host's 127.0.0.1:3456);
 *   - the task stamped as an ask of that agent (walnut_agent, and agent_id through
 *     updateTaskRaw: updateTask does not take it), so it lists under `Ask <agent>`, and
 *     linked to the session as this Mac's own start links it (the exec or plan slot, then
 *     session_id), so the Ask panel finds it after a reload and on every device;
 *   - title and organize scheduled here, never on the host (it holds no credentials).
 *
 * Idempotent: an existing record for the sid is a no-op. A task the Mac never got (its
 * create was refused) refuses the session too, into the letter.
 *
 * What a host may claim: only a task its OWN journal created (the task's created_by_op is
 * an op this Mac drained from that host), so a compromised host can never attach a session
 * to one of this Mac's tasks or stamp it as an ask; and only a mode this Mac's template for
 * that host allows (bypass only with the host's ask_bypass), else the record takes the
 * plain default (a resume from this Mac never runs in a mode the user did not allow).
 *
 * A record with `routine` is a claude-code routine's run the host started itself while
 * this Mac was away (clock-host-start-v1, clock-host-start-core.ts), on a task its own
 * journal created just before. It is adopted as this Mac files a routine's run
 * (quickStartSession): no agent stamp and no persona, the routine's title already on the
 * task, the task's folder set, the session context this Mac appends, and no title or
 * organize pass (a routine names both). Its mode is checked against the routine modes
 * (spawn-template.ts hostRoutineModes), never the ask rule. The run itself (its History
 * row) is recorded from the fire, which the host marked as started (trigger-events.ts).
 *
 * A record with `run: 'task'` is a plain session of a task made on that host while this Mac
 * was away (a plugin job's task_create, started from its project's session defaults and the
 * routine template: host-start-core.ts planTask). It is adopted the same way as a
 * routine's run (adoptRun), without the routine: never an ask, the task's folder set, the
 * session context this Mac appends, and the phase its start gives a TODO task online (In
 * Progress; the rescue's look at the CLI then hands a turn that already ended back, as a
 * reconnect does). Any other `run` is refused, never taken for an ask.
 *
 * A session record no rule takes is a RefusedWrite, the stores' own refusals included (one
 * session per task, a session of one task): never an error the drain retries, which would hold
 * the host's later records. An error that may pass (a busy database, a config read) stays a
 * retry. A `run: 'task'` record refused, or given up after its retries, has its CLI ended through
 * the daemon that owns it (endRefusedRun, called by offline-handover.ts once the letter says so),
 * since nothing here will ever look at it. An ask's stamp is written only once its record is.
 */

import { isInboxProject } from '../inbox-project.js';
import { log } from '../../logging/index.js';
import { WALNUT_HOME } from '../../constants.js';
import { RefusedWrite } from './patch-check.js';
import { resolveTaskId } from './apply-fields.js';
import { lookupDrained } from './ledger.js';
import type { V2Context, V2Record } from './apply-v2.js';
import { SESSION_MODEL_CLI_MAP, VALID_SESSION_EFFORT_IDS, VALID_SESSION_MODE_IDS, type SessionEffort, type SessionMode } from '../types.js';

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Sessions adopted by the drain now running, by host: offline-handover.ts rescues them after the batch. */
export const adoptedSessions = new Map<string, Set<string>>();

export async function applySession(ctx: V2Context, record: V2Record): Promise<void> {
  try {
    await applySessionRecord(ctx, record);
  } catch (err) {
    throw refusalOf(err) ?? err;
  }
}

/** The stores' own refusals of a session record (see the header), as a RefusedWrite; null for any other error. */
const STORE_REFUSALS = new Set(['TaskSessionTakenError', 'SessionOwnedByOtherTaskError']);
function refusalOf(err: unknown): RefusedWrite | null {
  if (err instanceof RefusedWrite) return err;
  return err instanceof Error && STORE_REFUSALS.has(err.name) ? new RefusedWrite(err.message) : null;
}

/** A task by its exact id, null only when there is none: any other error (a busy database) is thrown, a retry. */
async function taskOrNull(id: string): Promise<import('../types.js').Task | null> {
  if (!id) return null;
  const [{ getTask }, { missingIdMessage }] = await Promise.all([import('../task-manager.js'), import('../../lib/id-ref.js')]);
  return getTask(id).catch((err: unknown) => {
    if (err instanceof Error && err.message === missingIdMessage(id)) return null;
    throw err;
  });
}

async function applySessionRecord(ctx: V2Context, record: V2Record): Promise<void> {
  const sid = typeof record.sid === 'string' ? record.sid : '';
  if (!SID_RE.test(sid)) throw new RefusedWrite('a session record without a session id');
  const { getSessionByClaudeId, createSessionRecord } = await import('../session-tracker.js');
  const existing = await getSessionByClaudeId(sid);
  if (existing) {
    // An earlier drain made the record (its ack was lost, or it stopped before the link or the
    // rescue): the task gets the link and an ask its stamp now if it lacks them, never a second
    // record, and the connection looks at the CLI as after the first drain.
    const linkedTo = existing.taskId ? await taskOrNull(existing.taskId) : null;
    if (linkedTo) {
      const ours = existing.host === ctx.hostKey;
      if (ours && isAsk(record)) await stampAsk(linkedTo, record);
      if (!(linkedTo.session_ids ?? []).includes(sid)) await linkAdopted(linkedTo.id, sid, existing.mode === 'plan' ? 'plan' : 'exec');
      if (ours) rescueAfterBatch(ctx.hostKey, sid);
    }
    ctx.result.skipped++;
    return;
  }
  const taskId = resolveTaskId(ctx.hostKey, String(record.taskId ?? ''), ctx.remap);
  const task = await taskOrNull(taskId);
  if (!task || task.id !== taskId) throw new RefusedWrite(`the task of that ask (${taskId}) is not on this Mac`);
  if (!task.created_by_op || lookupDrained(WALNUT_HOME, task.created_by_op, ctx.hostKey)?.outcome !== 'applied') {
    throw new RefusedWrite(`the task of that ask (${taskId}) was not created by ${ctx.hostKey} while this Mac was away`);
  }
  // A run the host started from the routine template: a routine's, or a plugin job's new task's.
  if (record.routine !== undefined) return await adoptRun(ctx, record, sid, task, routineOf(record));
  if (record.run === 'task') return await adoptRun(ctx, record, sid, task, null);
  if (record.run !== undefined) throw new RefusedWrite(`a session record of a run this Mac does not know (${String(record.run)})`);
  const agentId = agentOf(record);
  const cwd = typeof record.cwd === 'string' && record.cwd.startsWith('/') ? record.cwd : undefined;
  const mode = await allowedMode(ctx.hostKey, record.mode, sid);
  const effort = typeof record.effort === 'string' && VALID_SESSION_EFFORT_IDS.has(record.effort) ? record.effort as SessionEffort : undefined;
  const model = typeof record.model === 'string' && record.model ? (SESSION_MODEL_CLI_MAP[record.model] ?? record.model) : undefined;
  // The persona this Mac renders for that agent, without this Mac's walnut mount (see above).
  let profile: import('../types.js').SessionProfile | undefined;
  try {
    const [{ buildLaneProfile }, { getConfig }] = await Promise.all([
      import('../sessions/personal-ai-lane.js'), import('../config-manager.js'),
    ]);
    // Its session context (below) carries USER.md.
    const built = (await buildLaneProfile(await getConfig(), agentId, { userInSessionContext: true })).profile;
    const { mcpServers: _mac, ...rest } = built;
    profile = rest;
  } catch (err) {
    log.session.warn('offline handover: no persona for an adopted ask; a cold resume runs without it', { host: ctx.hostKey, sessionId: sid, taskId, error: err instanceof Error ? err.message : String(err) });
  }
  let appendPrompt = '';
  try {
    const { buildSessionContext } = await import('../sessions/session-context.js');
    appendPrompt = (await buildSessionContext(taskId, cwd, ctx.hostKey)).systemPrompt;
  } catch { /* the context is additive: a resume without it still answers */ }
  const title = typeof record.title === 'string' ? record.title.slice(0, 500) : '';
  await adoptOutsideRecord({ claudeSessionId: sid, taskId, profile }, () => createSessionRecord(sid, taskId, task.project ?? '', cwd, {
    host: ctx.hostKey,
    ...(title ? { title } : {}),
    ...(mode ? { mode } : {}),
    ...(model ? { cliModel: model } : {}),
    ...(effort ? { effort } : {}),
    ...(profile ? { profile } : {}),
    appliedAppendSystemPrompt: appendPrompt,
    // The rescue after the batch looks at the CLI as a reconnect does (it may have stopped since).
    initialProcessStatus: 'stopped',
  }));
  // The ask's stamp and the task's session, as this Mac's own start links it (claude-code-session.ts
  // after init), only now the record is made (a refused record leaves the task as it was). A
  // write that fails throws, and the retry takes the branch above.
  rescueAfterBatch(ctx.hostKey, sid);
  await stampAsk(task, record);
  await linkAdopted(taskId, sid, mode === 'plan' ? 'plan' : 'exec');
  ctx.result.replayed++;
  log.session.info('offline handover: adopted an ask the host started while this Mac was away', { host: ctx.hostKey, sessionId: sid, taskId, agentId, mode, model });
  scheduleFollowups(sid, taskId, cwd ?? '', typeof record.firstMessage === 'string' ? record.firstMessage : '', task.title ?? '', task.project ?? '');
}

const isAsk = (record: V2Record) => record.routine === undefined && record.run === undefined;
const agentOf = (record: V2Record) => (typeof record.agentId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(record.agentId) ? record.agentId : 'general');

/** The task stamped as an ask of the record's agent (see the header), unless it is already. */
async function stampAsk(task: import('../types.js').Task, record: V2Record): Promise<void> {
  const agentId = agentOf(record);
  if (task.walnut_agent && (agentId === 'general' || task.agent_id === agentId)) return;
  const { updateTaskRaw } = await import('../task-manager.js');
  // agent_id is create-time data for updateTask; the raw write takes it (lane-ask-link.ts stampAsAsk).
  await updateTaskRaw(task.id, { walnut_agent: true, ...(agentId !== 'general' ? { agent_id: agentId } : {}) }, { source: 'offline-handover' });
}

/** The session of a `run: 'task'` record a host started alone (its id), or null for any other record. */
export function taskRunSession(record: { kind?: unknown; run?: unknown; routine?: unknown; sid?: unknown }): string | null {
  if (record.kind !== 'session' || record.run !== 'task' || record.routine !== undefined) return null;
  return typeof record.sid === 'string' && SID_RE.test(record.sid) ? record.sid : null;
}

/** The letter's words for a refused or given-up run whose CLI is ended (endRefusedRun), or ''. */
export function refusedRunWords(record: { kind?: unknown; run?: unknown; routine?: unknown; sid?: unknown }, hostKey: string): string {
  const sid = taskRunSession(record);
  return sid ? `; its session ${sid} on ${hostKey} is being ended` : '';
}

/**
 * A refused or given-up run's CLI, ended through the daemon that owns it (owner-stop.ts: the
 * server never signals a pid). Not awaited: the drain goes on whatever the daemon answers.
 */
export function endRefusedRun(record: { kind?: unknown; run?: unknown; routine?: unknown; sid?: unknown }, hostKey: string): void {
  const sid = taskRunSession(record);
  if (!sid) return;
  void (async () => {
    const { stopThroughOwner } = await import('../sessions/owner-stop.js');
    const outcome = await stopThroughOwner({ claudeSessionId: sid, host: hostKey }, 'maintenance', 'its start while this Mac was away was not adopted');
    log.session.info('offline handover: a session this Mac did not adopt was asked to end', { host: hostKey, sessionId: sid, outcome });
  })().catch((err: unknown) => log.session.warn('offline handover: a session this Mac did not adopt could not be asked to end', { host: hostKey, sessionId: sid, error: err instanceof Error ? err.message : String(err) }));
}

/** The routine a routine run's record names (see the header); refused without one. */
function routineOf(record: V2Record): { id: string; slotMs: number } {
  const r = record.routine as { id?: unknown; slotMs?: unknown } | null;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || typeof r.slotMs !== 'number') throw new RefusedWrite('a session record of a routine run without its routine');
  return { id: r.id, slotMs: r.slotMs };
}

/**
 * A run the host started from the routine template (see the header): a routine's (`routine`
 * set) or a plugin job's new task's (`run: 'task'`). Its session record and the task's link.
 */
async function adoptRun(
  ctx: V2Context, record: V2Record, sid: string, task: import('../types.js').Task, routine: { id: string; slotMs: number } | null,
): Promise<void> {
  const { createSessionRecord } = await import('../session-tracker.js');
  const { updateTaskRaw } = await import('../task-manager.js');
  const taskId = task.id;
  const cwd = typeof record.cwd === 'string' && record.cwd.startsWith('/') ? record.cwd : undefined;
  const mode = await allowedRoutineMode(ctx.hostKey, record.mode, sid);
  const effort = typeof record.effort === 'string' && VALID_SESSION_EFFORT_IDS.has(record.effort) ? record.effort as SessionEffort : undefined;
  const model = typeof record.model === 'string' && record.model ? (SESSION_MODEL_CLI_MAP[record.model] ?? record.model) : undefined;
  // The run's folder on its task, as quickStartSession files it (a queued create cannot carry it).
  if (cwd && !task.cwd) await updateTaskRaw(taskId, { cwd }, { source: 'offline-handover' });
  let appendPrompt = '';
  try {
    const { buildSessionContext } = await import('../sessions/session-context.js');
    appendPrompt = (await buildSessionContext(taskId, cwd, ctx.hostKey)).systemPrompt;
  } catch { /* the context is additive: a resume without it still answers */ }
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.slice(0, 500) : task.title ?? '';
  // A task's start sent its first message (`run: 'task'`): the phase that input gives online, written
  // BEFORE the session record, so the reconnect's look at the CLI (the rescue) hands a turn that
  // already ended back exactly as online (session-snapshot-apply.ts: a phase set after the record's
  // status would read as a person's later choice and be kept).
  // A drain cut between that phase and the record (a crash) left the phase written: this drain's
  // retry takes it as its own (ownStartPhase), so a refusal now still takes it back.
  const started = routine ? null : await startPhase(taskId, sid, ctx.at) ?? await ownStartPhase(taskId, sid, ctx.at);
  try {
    await adoptOutsideRecord({ claudeSessionId: sid, taskId }, () => createSessionRecord(sid, taskId, task.project ?? '', cwd, {
      host: ctx.hostKey,
      ...(title ? { title } : {}),
      ...(mode ? { mode } : {}),
      ...(model ? { cliModel: model } : {}),
      ...(effort ? { effort } : {}),
      appliedAppendSystemPrompt: appendPrompt,
      initialProcessStatus: 'stopped',
    }));
  } catch (err) {
    // No session was adopted: the task reads as it did (a retry writes the phase again).
    if (started) await undoStartPhase(taskId, started);
    throw err;
  }
  rescueAfterBatch(ctx.hostKey, sid);
  await linkAdopted(taskId, sid, mode === 'plan' ? 'plan' : 'exec');
  ctx.result.replayed++;
  if (routine) log.session.info('offline handover: adopted a routine run the host started while this Mac was away', { host: ctx.hostKey, sessionId: sid, taskId, jobId: routine.id, slotMs: routine.slotMs, mode, model });
  else log.session.info('offline handover: adopted the session of a task a plugin job created while this Mac was away', { host: ctx.hostKey, sessionId: sid, taskId, mode, model });
}

/**
 * The phase a task's start gives it online, for a task still TODO: the start's message is the
 * session's input. Its field time is the start's own (`startedAt`, this server's clock), not the
 * drain's, so a phase the host wrote after the start (drained next, judged newer by time:
 * task-fields.ts) still wins over it. Returns when it was written (`phase_changed_at`), or null
 * when nothing moved.
 */
async function startPhase(taskId: string, sid: string, startedAt: number): Promise<string | null> {
  const { applySessionPhase } = await import('../phase.js');
  const moved = await applySessionPhase(taskId, 'session:input', 'offline-handover', {
    sessionId: sid, shouldApply: (current) => current.phase === 'TODO',
  });
  if (!moved.changed) return null;
  const { getTask, updateTaskRaw } = await import('../task-manager.js');
  const written = (await getTask(taskId)).phase_changed_at ?? null;
  const at = new Date(startedAt).toISOString();
  await updateTaskRaw(taskId, (t) => ({ field_at: { ...(t.field_at ?? {}), phase: at } }), {
    source: 'offline-handover',
    shouldUpdate: (t) => t.phase === 'IN_PROGRESS' && t.phase_changed_at === written && Number.isFinite(startedAt) && (t.field_at?.phase ?? '') > at,
  }).catch((err: unknown) => log.session.warn('offline handover: a start\'s phase kept the drain\'s time', { taskId, error: err instanceof Error ? err.message : String(err) }));
  return written;
}

/** How far a start's field time may be from the record's time on a later drain (its clock offset is measured again). */
const START_FIELD_SLACK_MS = 60_000

/**
 * The phase an earlier drain of this same start wrote (startPhase) and then did not live to give
 * a session (the record is drained again): the task In Progress, this session not linked to it,
 * and the phase's field time the start's own. Returns its `phase_changed_at`, or null.
 */
async function ownStartPhase(taskId: string, sid: string, startedAt: number): Promise<string | null> {
  const { getTask } = await import('../task-manager.js');
  const t = await getTask(taskId).catch(() => null);
  if (!t || t.phase !== 'IN_PROGRESS' || (t.session_ids ?? []).includes(sid) || !t.phase_changed_at) return null;
  const fieldAt = Date.parse(t.field_at?.phase ?? '');
  return Number.isFinite(fieldAt) && Math.abs(fieldAt - startedAt) <= START_FIELD_SLACK_MS ? t.phase_changed_at : null;
}

/**
 * The start's phase taken back, only while nothing moved it since: through the phase API, so it
 * is pushed and told as the forward write was (the task's status, its parent's notice).
 */
async function undoStartPhase(taskId: string, writtenAt: string): Promise<void> {
  const { applySessionPhase } = await import('../phase.js');
  await applySessionPhase(taskId, 'reconciler', 'offline-handover', {
    newPhase: 'TODO', shouldApply: (current) => current.phase === 'IN_PROGRESS' && current.phase_changed_at === writtenAt,
  }).catch((err: unknown) => log.session.warn('offline handover: a refused run\'s start phase was not taken back', { taskId, error: err instanceof Error ? err.message : String(err) }));
}

/**
 * A host's adopted session is outside history (router/history-write.ts): never into an area task
 * or with an area profile. Checked first, and the store's own check maps the same way.
 */
async function adoptOutsideRecord(
  record: { claudeSessionId: string; taskId: string; profile?: import('../types.js').SessionProfile },
  create: () => Promise<unknown>,
): Promise<void> {
  const { assertOutsideHistoryImport, isHistoryRefusal, taskDbHandle } = await import('../router/history-write.js');
  try {
    assertOutsideHistoryImport(record, taskDbHandle());
    await create();
  } catch (err) {
    if (isHistoryRefusal(err)) throw new RefusedWrite((err as Error).message);
    throw err;
  }
}

/** A run's mode when this Mac lets a routine-template run start in it on a host; else the plain default. */
async function allowedRoutineMode(hostKey: string, raw: unknown, sid: string): Promise<SessionMode | undefined> {
  if (typeof raw !== 'string' || !VALID_SESSION_MODE_IDS.has(raw)) return undefined;
  const { hostRoutineModes } = await import('../../providers/spawn-template.js');
  if (Object.prototype.hasOwnProperty.call(hostRoutineModes().modes, raw)) return raw as SessionMode;
  log.session.warn('offline handover: an adopted run names a mode the routine template may not start in; it keeps the default', { host: hostKey, sessionId: sid, mode: raw });
  return 'default';
}

/** The record's mode when this Mac's template for that host allows it; else the plain default. */
async function allowedMode(hostKey: string, raw: unknown, sid: string): Promise<SessionMode | undefined> {
  if (typeof raw !== 'string' || !VALID_SESSION_MODE_IDS.has(raw)) return undefined;
  const [{ hostAskModes }, { getConfig }] = await Promise.all([
    import('../../providers/spawn-template.js'), import('../config-manager.js'),
  ]);
  const bypass = (await getConfig()).hosts?.[hostKey]?.server?.ask_bypass === true;
  if (Object.prototype.hasOwnProperty.call(hostAskModes(bypass).modes, raw)) return raw as SessionMode;
  log.session.warn('offline handover: an adopted ask names a mode its host may not start; it keeps the default', { host: hostKey, sessionId: sid, mode: raw });
  return 'default';
}

/** The rescue after the batch looks at the adopted session's CLI as a reconnect does. */
function rescueAfterBatch(hostKey: string, sid: string): void {
  const set = adoptedSessions.get(hostKey) ?? new Set<string>();
  set.add(sid);
  adoptedSessions.set(hostKey, set);
}

/** Link an adopted session to its task (slot and list) and tell the web. */
async function linkAdopted(taskId: string, sid: string, slot: 'plan' | 'exec'): Promise<void> {
  const { linkSessionSlot, linkSession } = await import('../task-manager.js');
  await linkSessionSlot(taskId, sid, slot);
  const { task: linked } = await linkSession(taskId, sid);
  const { bus, EventNames } = await import('../event-bus.js');
  bus.emit(EventNames.TASK_UPDATED, { task: linked }, ['web-ui'], { source: 'offline-handover' });
}

/** Title and organize, here after adoption (the host holds no model credentials). Fire and forget. */
function scheduleFollowups(sid: string, taskId: string, cwd: string, message: string, title: string, project: string): void {
  void (async () => {
    const { backgroundAiDisabled } = await import('../cheap-model.js');
    if (backgroundAiDisabled() || !message.trim()) return;
    const [{ autoTitleFromLaunch }, { organizeQuickStartTask }] = await Promise.all([
      import('../session-hooks/builtins.js'), import('../session-organize.js'),
    ]);
    // The ask still wears its placeholder (its project's name): the launch title replaces it.
    await autoTitleFromLaunch(sid, taskId, message, cwd, title).catch((err: unknown) => log.session.warn('offline handover: an adopted ask was not titled', { sessionId: sid, taskId, error: err instanceof Error ? err.message : String(err) }));
    // As a launch here: placement only for a task its launch left unfiled (an ask names its project).
    if (isInboxProject(project)) await organizeQuickStartTask(taskId, cwd, message).catch((err: unknown) => log.session.warn('offline handover: an adopted ask was not organized', { sessionId: sid, taskId, error: err instanceof Error ? err.message : String(err) }));
  })().catch(() => {});
}
