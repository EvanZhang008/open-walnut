import { getTask, listTasksSlim } from '../task-manager.js';
import { getSessionsForTask } from '../session-tracker.js';
import type { InboxCurrentTaskStatus, InboxTaskPage, InboxTaskPreview } from './types.js';
import { ItemActionError } from './item-ledger.js';
import { getConnectedDaemonConnection } from '../../providers/daemon-connection.js';
import { isAcpEngine } from '../agents/engine-registry.js';
import { isWakeupArmed, type SessionSnapshot } from '../../providers/daemon-fold.js';
import type { SessionRecord } from '../types.js';

async function liveProcessStatus(record: SessionRecord): Promise<InboxCurrentTaskStatus['status']> {
  const connection = getConnectedDaemonConnection(record.host || '__local__');
  if (!connection) return 'unavailable';
  try {
    if (isAcpEngine(record.engine)) {
      if (!record.acpRuntimeId) return 'unavailable';
      const reply = await connection.send('acpState', { sid: record.acpRuntimeId }, 1500);
      if (reply.ok !== true) return reply.errorKind === 'no_worker' ? 'stopped' : 'unavailable';
      const state = reply.result as { providerSessionId?: string; turnActive?: boolean; pendingPermissions?: unknown[] } | undefined;
      if (state?.providerSessionId !== record.claudeSessionId || typeof state.turnActive !== 'boolean'
        || !Array.isArray(state.pendingPermissions)) return 'unavailable';
      return state.pendingPermissions.length ? 'waiting_permission' : state.turnActive ? 'running' : 'idle';
    }
    const reply = await connection.send('getState', { sid: record.claudeSessionId }, 1500);
    if (reply.ok !== true || typeof reply.alive !== 'boolean') return 'unavailable';
    const snapshot = reply.snapshot as SessionSnapshot | undefined;
    if (!reply.alive) return snapshot?.lastResult?.isError || (snapshot?.exitCode ?? 0) !== 0 ? 'error' : 'stopped';
    if (!snapshot || typeof snapshot.turnActive !== 'boolean'
      || !['running', 'idle', 'waiting', 'dead'].includes(snapshot.cliState)) return 'unavailable';
    if (snapshot.cliState === 'dead') return 'unavailable';
    if (snapshot.pendingPermission || snapshot.cliState === 'waiting') return 'waiting_permission';
    if (snapshot.turnActive || (snapshot.detachedBgCount ?? 0) > 0 || isWakeupArmed(snapshot.wakeupAt)) return 'running';
    return snapshot.lastResult?.isError ? 'error' : 'idle';
  } catch { return 'unavailable'; }
}

export async function exactItemTask(id: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ItemActionError('invalid_target', 'Select a complete task ID', 400);
  let task: Awaited<ReturnType<typeof getTask>>;
  try { task = await getTask(id); }
  catch (error) {
    if (error instanceof Error && /No task found matching/.test(error.message)) throw new ItemActionError('target_deleted', 'Target deleted', 404);
    throw new ItemActionError('target_unavailable', 'Target unavailable', 503);
  }
  if (task.id !== id) throw new ItemActionError('invalid_target', 'Select a complete task ID', 400);
  return task;
}
export async function itemTaskPreview(id: string): Promise<InboxTaskPreview> {
  const task = await exactItemTask(id);
  return { id: task.id, title: task.title, project: task.project ?? '', phase: task.phase,
    description: task.description || undefined, summary: task.summary || undefined, updatedAt: task.updated_at,
    ...(task.note ? { activity: [{ text: task.note.slice(-4000), at: task.updated_at }] } : {}),
  };
}
export async function itemTaskPage(query: string, offset: number, limit: number): Promise<InboxTaskPage> {
  const needle = query.trim().toLocaleLowerCase();
  const tasks = (await listTasksSlim({ minimal: true })).filter(t => !t.org_role && !t.plugin_only && (t.title !== '.metadata'))
    .filter(t => !needle || t.id.toLocaleLowerCase() === needle || t.title.toLocaleLowerCase().includes(needle) || (t.project ?? '').toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  return { tasks: tasks.slice(offset, offset + limit).map(t => ({ id: t.id, title: t.title, project: t.project ?? '', phase: t.phase })),
    total: tasks.length, offset, limit, hasMore: offset + limit < tasks.length };
}
export async function currentItemTaskStatus(id: string): Promise<InboxCurrentTaskStatus> {
  const observedAt = new Date().toISOString();
  try {
    const task = await exactItemTask(id);
    if (task.phase === 'COMPLETE') return { taskId: id, phase: task.phase, status: 'completed', observedAt };
    if (task.phase === 'WAITING') return { taskId: id, phase: task.phase, status: 'waiting', observedAt };
    const sessions = await getSessionsForTask(id);
    const record = sessions.find(r => r.claudeSessionId === (task.session_id ?? task.exec_session_id ?? task.last_start?.session_id));
    let status: InboxCurrentTaskStatus['status'] = 'unavailable';
    if (record) {
      status = record.status_reason === 'remote_unreachable' || record.status_reason === 'spawn_outcome_unknown' ? 'unavailable'
        : record.status_reason === 'awaiting_spawn' ? 'starting'
        : record.process_status === 'running' || record.process_status === 'idle' ? await liveProcessStatus(record)
        : record.process_status === 'error' ? 'error'
        : record.process_status === 'stopped' ? 'stopped' : 'unavailable';
      // The one user state (user-status.ts): a snoozed task waits on its date, not on the user.
      if (status === 'idle' && (task.user_status ? task.user_status.state === 'needs' : task.phase === 'NEED_ACTION')) status = 'waiting_user';
    } else if (task.last_start?.state === 'starting') status = 'starting';
    else if (task.last_start?.state === 'failed') status = 'error';
    else if (!task.last_start && sessions.length === 0) status = 'idle';
    return { taskId: id, phase: task.phase, status, observedAt, ...(record ? { sessionId: record.claudeSessionId } : {}) };
  } catch (error) {
    return { taskId: id, status: error instanceof ItemActionError && error.code === 'target_deleted' ? 'deleted' : 'unavailable', observedAt };
  }
}
