/**
 * Walnut, not the node's memory, keeps a thread's summary current (2026-11-08, the user, twice in
 * an hour on cards that kept the node's old summary after he had written in the thread: "Walnut
 * needs to make sure it doesn't happen"). When Main or a lead ends a turn while one of its open
 * threads holds a message of his newer than its summary (thread-view.ts summaryBehindHim), its
 * Stop hook answers block with those threads named, the way a request it has not answered is
 * (unanswered-at-stop.ts): the CLI goes on in the same turn and rewrites them (or sets pending for
 * one that only went to a team). Once per turn (the hook's own `stop_hook_active`), and one thread
 * is named for one message of his at most MAX_SUMMARY_NUDGES times. Never throws.
 */
import { snoozedNow, summaryBehindHim } from './thread-view.js';
import type { OrgThread } from './threads-model.js';

export const MAX_SUMMARY_NUDGES = 2;
const nudged = new Map<string, number>();

/** For tests. */
export function resetSummaryNudges(): void { nudged.clear(); }

/** The open threads whose summary his latest message outdated. Pure. */
export function staleSummaries(threads: readonly OrgThread[], nowMs: number): OrgThread[] {
  return threads.filter((t) => !t.closed && t.state !== 'pending' && !snoozedNow(t, nowMs) && summaryBehindHim(t));
}

const lastHisAt = (t: OrgThread) => t.messages.reduce((a, m) => (m.at > a ? m.at : a), '');

export function staleSummaryReason(threads: readonly OrgThread[]): string {
  const lines = threads.map((t) => `- ${t.id} ${JSON.stringify(t.title)}: ${t.reply?.trim() ? 'its summary is older than his message' : 'no summary yet'} (his message ${lastHisAt(t)})`);
  return 'Walnut: before this turn ends, these Threads do not say where they stand after his latest message:\n'
    + `${lines.join('\n')}\n`
    + 'Rewrite each summary now (thread_update reply, latest first, with its state), or set pending for one that only went to a team.';
}

export async function staleSummariesAtStop(callerSid: string | undefined, nowMs = Date.now()): Promise<{ reason: string; threads: string[] } | null> {
  const sid = (callerSid ?? '').trim();
  if (!sid) return null;
  try {
    const { isCompanion } = await import('../server-role.js');
    if (isCompanion()) return null;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const taskId = (await getSessionByClaudeId(sid).catch(() => null))?.taskId;
    if (!taskId) return null;
    const { listTasksByIds } = await import('../task-manager.js');
    const task = (await listTasksByIds([taskId]).catch(() => []))[0];
    if (!task || (task.org_role !== 'main' && task.org_role !== 'lead') || task.phase === 'COMPLETE') return null;
    const { readThreads } = await import('./threads-store.js');
    const stale = staleSummaries((await readThreads(taskId)).threads, nowMs)
      .filter((t) => (nudged.get(`${taskId}:${t.id}:${lastHisAt(t)}`) ?? 0) < MAX_SUMMARY_NUDGES)
      .slice(0, 8);
    if (!stale.length) return null;
    for (const t of stale) {
      const key = `${taskId}:${t.id}:${lastHisAt(t)}`;
      nudged.set(key, (nudged.get(key) ?? 0) + 1);
    }
    // A long-running server: forget the oldest names.
    while (nudged.size > 2000) nudged.delete(nudged.keys().next().value as string);
    return { reason: staleSummaryReason(stale), threads: stale.map((t) => t.id) };
  } catch {
    return null;
  }
}
