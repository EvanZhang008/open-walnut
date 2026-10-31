/**
 * A VP and Main hear the tasks they follow the way a leader hears its workers (2026-10-31, the
 * user: "a leader and its worker have a very strong bond ... when the worker finishes, it gives the leader
 * its last message at once ... I want to know how a VP works"; a VP had only a one-line status move, so it knew something
 * finished but not what came of it).
 *
 * A task with no leader (a top-level task) reports to its project's VP, or to Main when no VP
 * leads its project; a VP reports to Main (statusFollowersOf, one level up). At each edge a
 * leader's worker would report (its turn ended with the task open, it completed, it erred, it
 * waits on the user, it parked itself: the request-watch hook in session-hooks/builtins.ts), the
 * same envelope a subtask notice is (subtask-notices.ts: its last message quoted, the actions
 * after it) goes to that node. A worker under a leader keeps reporting to its leader only.
 *
 * Never a wake: it rides the node's next message (status-riding.ts), one item per task with the
 * task's newest status line inside, kept on disk across a restart, so an idle VP reads every
 * completion at its next turn and no node hears the same change twice. Nothing for a snoozed task
 * (the node brings news to the user, and a snooze says not before its date), a Personal AI ask, a
 * plugin's task, an edge the node's own session made, a node that holds a request to the task (its
 * reply notice speaks), a message the user's open terminal holds, or a stop right after the task
 * answered it.
 */
import { log } from '../../logging/index.js';
import { cutEnd } from '../text-cut.js';
import type { NoticeLastMessage } from '../session-requests.js';
import type { SubtaskNoticeKind } from '../peers/envelope-kit.js';
import type { Task } from '../types.js';

/** How much of a stop's last message a follower reads (task_history has the rest). */
export const STOP_QUOTE_MAX = 1_500;

export interface OrgEdge {
  kind: SubtaskNoticeKind;
  sessionId?: string;
  lastWords?: NoticeLastMessage;
  /** The message that started its last turn (who started it: the node's own message, a trigger, …). */
  openedBy?: Parameters<typeof import('./session-request-notify.js').turnStarterOf>[0];
  error?: string;
  blockedOn?: string;
  waitUntil?: string;
  /** The session whose own call made this edge. */
  actorSid?: string;
  /** Sessions holding an unanswered request to the task: their own notice answers them. */
  askerSids?: readonly string[];
}

/** Whether a task reports to an org node rather than to a leader. Pure. */
export function reportsToOrgNode(task: Pick<Task, 'parent_task_id' | 'org_role' | 'plugin_only' | 'walnut_agent' | 'user_status'>): boolean {
  if (task.org_role === 'main' || task.plugin_only || task.walnut_agent) return false;
  if (task.parent_task_id && task.org_role !== 'lead') return false;
  return !task.user_status?.snoozed;
}

/** The envelope, worded for a node that follows the task rather than leads it. Pure. */
export function orgNoticeText(text: string): string {
  return text.replace('Your subtask "', 'A task you follow, "');
}

/** Hand one edge to the node that follows the task. Never throws; answers whether it rides. */
export async function noteOrgEdge(task: Task, edge: OrgEdge): Promise<boolean> {
  try {
    if (!reportsToOrgNode(task)) return false;
    const { listTasks } = await import('../task-manager.js');
    const { followContext, followerSession, statusFollowersOf } = await import('./status-push.js');
    const all = await listTasks();
    const { byId, vpOf, main } = await followContext(all);
    let follower: Task | undefined;
    let rec: Awaited<ReturnType<typeof followerSession>> = null;
    for (const f of statusFollowersOf(task, byId, vpOf, main)) {
      if (f.phase === 'COMPLETE' || f.status === 'done') continue;
      if (!f.org_role) return false;
      rec = await followerSession(f.id);
      if (rec) { follower = f; break; }
    }
    if (!follower || !rec) return false;
    const { getSessionsForTask } = await import('../session-tracker.js');
    const followerSids = new Set((await getSessionsForTask(follower.id).catch(() => [])).map((s) => s.claudeSessionId));
    // Its own call made this edge (it completed the task, say): it knows.
    if (edge.actorSid && followerSids.has(edge.actorSid)) return false;
    // It asked the task something: the request's own notice tells it this edge, once.
    if (edge.askerSids?.some((sid) => followerSids.has(sid))) return false;
    const { repliedRecently } = await import('../session-requests.js');
    const { RECENT_REPLY_MS, buildSubtaskNoticeText } = await import('./subtask-notices.js');
    const answered = await repliedRecently(followerSids, task.id, RECENT_REPLY_MS).catch(() => false);
    // A stop right after its answer reached the node is no news: the answer was the update.
    if (edge.kind === 'stopped' && answered) return false;
    const { turnStarterOf } = await import('./session-request-notify.js');
    // A follower reads many tasks: a stop's quote is kept short, a completion's or an error's whole.
    const lastWords = edge.lastWords && edge.kind !== 'completed' && edge.kind !== 'error' && edge.lastWords.text.length > STOP_QUOTE_MAX
      ? { ...edge.lastWords, text: `${edge.lastWords.text.slice(0, cutEnd(edge.lastWords.text, STOP_QUOTE_MAX - 1))}…`, clipped: true }
      : edge.lastWords;
    const text = orgNoticeText(buildSubtaskNoticeText({
      parentTaskId: follower.id,
      child: { id: task.id, title: task.title, sessionId: edge.sessionId },
      kind: edge.kind,
      lastWords,
      startedBy: turnStarterOf(edge.openedBy, follower.id),
      error: edge.error,
      blockedOn: edge.blockedOn,
      waitUntil: edge.waitUntil,
      repliedRecently: answered,
    }));
    const { rideNotice } = await import('./status-riding.js');
    rideNotice(rec.claudeSessionId, task.id, edge.kind, text);
    log.session.info('org follow: the edge rides the next message of the node that follows the task', {
      taskId: task.id, kind: edge.kind, followerTaskId: follower.id, followerSid: rec.claudeSessionId,
    });
    return true;
  } catch (err) {
    log.session.warn('org follow failed', { taskId: task.id, kind: edge.kind, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Whether the node above could hear at all (the hook asks before it pays for a transcript read). */
export async function orgFollowerCanHear(task: Task): Promise<boolean> {
  if (!reportsToOrgNode(task)) return false;
  try {
    const { listTasks } = await import('../task-manager.js');
    const { followContext, followerSession, statusFollowersOf } = await import('./status-push.js');
    const { byId, vpOf, main } = await followContext(await listTasks());
    for (const f of statusFollowersOf(task, byId, vpOf, main)) {
      if (f.phase === 'COMPLETE' || f.status === 'done') continue;
      if (!f.org_role) return false;
      if (await followerSession(f.id)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
