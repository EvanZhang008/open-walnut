/**
 * A task joins an incoming-item area (as its router or as area work) only with a history the
 * area's isolated profile could have made. Every start and wake of an area task refuses a session
 * outside that profile (task-start.ts refuseForeignAreaSessions, wake.ts), so a task converted
 * with an earlier full-tool conversation would be stuck for good. The check runs before either
 * store is written: a task with no conversation at all, or one whose every conversation already
 * carries this area's profile for the same role, may join; anything else is refused and its
 * conversations are left exactly as they are. Unknown ids and an unreadable session store refuse
 * too (fail closed).
 */
import { OrgError } from '../org/org-store.js';
import { isRouterAreaSession } from './session-policy.js';
import type { RouterArea } from './areas.js';
import type { SessionRecord, Task } from '../types.js';

type HistoryTask = Pick<Task, 'id' | 'session_ids' | 'session_id' | 'plan_session_id' | 'exec_session_id' | 'legacy_session_ids'>;
type HistoryArea = Pick<RouterArea, 'id' | 'host'>;

/** Every session id the task names in a slot or its history lists. */
function namedSessionIds(task: HistoryTask): string[] {
  const ids = [task.session_id, task.exec_session_id, task.plan_session_id,
    ...(task.session_ids ?? []), ...(task.legacy_session_ids ?? [])];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id.trim()))];
}

async function readHistory(task: HistoryTask): Promise<{ records: SessionRecord[]; missing: string[] }> {
  const { getSessionsForTask, getSessionByClaudeId } = await import('../session-tracker.js');
  const byId = new Map<string, SessionRecord>();
  for (const record of await getSessionsForTask(task.id)) byId.set(record.claudeSessionId, record);
  const missing: string[] = [];
  for (const id of namedSessionIds(task)) {
    if (byId.has(id)) continue;
    const record = await getSessionByClaudeId(id);
    if (record) byId.set(id, record);
    else missing.push(id);
  }
  return { records: [...byId.values()], missing };
}

/** Throws 409 router_history_not_isolated unless the router task's history fits its area's router profile. */
export async function assertIsolatedHistory(task: HistoryTask, area: HistoryArea): Promise<void> {
  let history: Awaited<ReturnType<typeof readHistory>>;
  try {
    history = await readHistory(task);
  } catch (error) {
    throw new OrgError('router_history_unreadable', 503,
      `Task ${task.id}'s conversations could not be read (${error instanceof Error ? error.message : String(error)}). Nothing was changed; retry.`);
  }
  const fullArea = { id: area.id, host: area.host } as RouterArea;
  const foreign = history.records.filter((record) => record.taskId !== task.id || !isRouterAreaSession(record, fullArea)).map((record) => record.claudeSessionId);
  const outside = [...foreign, ...history.missing];
  if (outside.length === 0) return;
  throw new OrgError('router_history_not_isolated', 409,
    `Task ${task.id} already has ${outside.length === 1 ? 'a conversation' : `${outside.length} conversations`} (${outside.join(', ')}) `
    + `not started in area ${area.id}'s isolated router profile. Such a conversation has seen tools and `
    + 'context outside the area, so the area could never start or wake this task. Nothing was changed, and the old conversation is kept as it is: '
    + 'Walnut never deletes it to make room. Use a fresh task with no conversation for this area instead.');
}
