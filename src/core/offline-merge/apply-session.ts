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
 */

import { log } from '../../logging/index.js';
import { RefusedWrite } from './patch-check.js';
import { resolveTaskId } from './apply-fields.js';
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
  const agentId = typeof record.agentId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(record.agentId) ? record.agentId : 'general';
  if (!task.walnut_agent || (agentId !== 'general' && task.agent_id !== agentId)) {
    // agent_id is create-time data for updateTask; the raw write takes it (lane-ask-link.ts stampAsAsk).
    await updateTaskRaw(taskId, { walnut_agent: true, ...(agentId !== 'general' ? { agent_id: agentId } : {}) }, { source: 'offline-handover' });
  }
  const cwd = typeof record.cwd === 'string' && record.cwd.startsWith('/') ? record.cwd : undefined;
  const mode = typeof record.mode === 'string' && VALID_SESSION_MODE_IDS.has(record.mode) ? record.mode as SessionMode : undefined;
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
