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
 */

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
  const sid = typeof record.sid === 'string' ? record.sid : '';
  if (!SID_RE.test(sid)) throw new RefusedWrite('a session record without a session id');
  const { getSessionByClaudeId, createSessionRecord } = await import('../session-tracker.js');
  const { getTask, updateTaskRaw } = await import('../task-manager.js');
  const existing = await getSessionByClaudeId(sid).catch(() => null);
  if (existing) {
    // An earlier drain made the record (its ack was lost, or it stopped before the link): the
    // task gets the link now if it does not list the session yet, never a second record.
    const linkedTo = existing.taskId ? await getTask(existing.taskId).catch(() => null) : null;
    if (linkedTo && !(linkedTo.session_ids ?? []).includes(sid)) {
      await linkAdopted(linkedTo.id, sid, existing.mode === 'plan' ? 'plan' : 'exec');
      rescueAfterBatch(ctx.hostKey, sid);
    }
    ctx.result.skipped++;
    return;
  }
  const taskId = resolveTaskId(ctx.hostKey, String(record.taskId ?? ''), ctx.remap);
  const task = await getTask(taskId).catch(() => null);
  if (!task || task.id !== taskId) throw new RefusedWrite(`the task of that ask (${taskId}) is not on this Mac`);
  if (!task.created_by_op || lookupDrained(WALNUT_HOME, task.created_by_op, ctx.hostKey)?.outcome !== 'applied') {
    throw new RefusedWrite(`the task of that ask (${taskId}) was not created by ${ctx.hostKey} while this Mac was away`);
  }
  if (record.routine !== undefined) return await adoptRoutineRun(ctx, record, sid, task);
  const agentId = typeof record.agentId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(record.agentId) ? record.agentId : 'general';
  if (!task.walnut_agent || (agentId !== 'general' && task.agent_id !== agentId)) {
    // agent_id is create-time data for updateTask; the raw write takes it (lane-ask-link.ts stampAsAsk).
    await updateTaskRaw(taskId, { walnut_agent: true, ...(agentId !== 'general' ? { agent_id: agentId } : {}) }, { source: 'offline-handover' });
  }
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
    const built = (await buildLaneProfile(await getConfig(), agentId)).profile;
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
  await createSessionRecord(sid, taskId, task.project ?? '', cwd, {
    host: ctx.hostKey,
    ...(title ? { title } : {}),
    ...(mode ? { mode } : {}),
    ...(model ? { cliModel: model } : {}),
    ...(effort ? { effort } : {}),
    ...(profile ? { profile } : {}),
    appliedAppendSystemPrompt: appendPrompt,
    // The rescue after the batch looks at the CLI as a reconnect does (it may have stopped since).
    initialProcessStatus: 'stopped',
  });
  // The task's session, as this Mac's own start links it (claude-code-session.ts after init).
  // The record is made already: a link that fails throws, and the retry takes the branch above.
  rescueAfterBatch(ctx.hostKey, sid);
  await linkAdopted(taskId, sid, mode === 'plan' ? 'plan' : 'exec');
  ctx.result.replayed++;
  log.session.info('offline handover: adopted an ask the host started while this Mac was away', { host: ctx.hostKey, sessionId: sid, taskId, agentId, mode, model });
  scheduleFollowups(sid, taskId, cwd ?? '', typeof record.firstMessage === 'string' ? record.firstMessage : '', task.title ?? '', task.project ?? '');
}

/** A routine run the host started (see the header): its session record and the task's link. */
async function adoptRoutineRun(ctx: V2Context, record: V2Record, sid: string, task: import('../types.js').Task): Promise<void> {
  const r = record.routine as { id?: unknown; slotMs?: unknown } | null;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || typeof r.slotMs !== 'number') throw new RefusedWrite('a routine session record without its routine');
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
  await createSessionRecord(sid, taskId, task.project ?? '', cwd, {
    host: ctx.hostKey,
    ...(title ? { title } : {}),
    ...(mode ? { mode } : {}),
    ...(model ? { cliModel: model } : {}),
    ...(effort ? { effort } : {}),
    appliedAppendSystemPrompt: appendPrompt,
    initialProcessStatus: 'stopped',
  });
  rescueAfterBatch(ctx.hostKey, sid);
  await linkAdopted(taskId, sid, mode === 'plan' ? 'plan' : 'exec');
  ctx.result.replayed++;
  log.session.info('offline handover: adopted a routine run the host started while this Mac was away', { host: ctx.hostKey, sessionId: sid, taskId, jobId: r.id, slotMs: r.slotMs, mode, model });
}

/** A routine run's mode when this Mac lets a routine run in it on a host; else the plain default. */
async function allowedRoutineMode(hostKey: string, raw: unknown, sid: string): Promise<SessionMode | undefined> {
  if (typeof raw !== 'string' || !VALID_SESSION_MODE_IDS.has(raw)) return undefined;
  const { hostRoutineModes } = await import('../../providers/spawn-template.js');
  if (Object.prototype.hasOwnProperty.call(hostRoutineModes().modes, raw)) return raw as SessionMode;
  log.session.warn('offline handover: an adopted routine run names a mode a routine may not start in; it keeps the default', { host: hostKey, sessionId: sid, mode: raw });
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
    if (!project) await organizeQuickStartTask(taskId, cwd, message).catch((err: unknown) => log.session.warn('offline handover: an adopted ask was not organized', { sessionId: sid, taskId, error: err instanceof Error ? err.message : String(err) }));
  })().catch(() => {});
}
