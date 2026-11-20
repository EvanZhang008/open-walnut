/**
 * Walnut, not the node's memory, keeps a thread's summary current (2026-11-08, the user, twice in
 * an hour on cards that kept the node's old summary after he had written in the thread: "Walnut
 * needs to make sure it doesn't happen"). When Main or a lead ends a turn while one of its open
 * threads holds a message of his newer than its summary (thread-view.ts summaryBehindHim), its
 * Stop hook answers block with those threads named, the way a request it has not answered is
 * (unanswered-at-stop.ts): the CLI goes on in the same turn and rewrites them (or sets pending for
 * one that only went to a team). Once per turn (the hook's own `stop_hook_active`), and one thread
 * is named for one message of his at most MAX_SUMMARY_NUDGES times. Never throws.
 *
 * It also names an answered thread he wrote to the node after, in another thread (answeredBeforeHim;
 * 2026-11-20, the user, on a thread card that stayed up as unread while he kept talking about it
 * in the chat: the model has to know how to keep its threads itself): his words may build on its
 * answer, and only the node can tell. It checks each against what he said since: marks the read
 * one known, closes the one that is done, and leaves a thread waiting on him with only the
 * question still open. Named once per message of his (thread-checks.ts keeps it across restarts).
 */
import { hasThreadNews, snoozedNow, summaryAt, summaryBehindHim } from './thread-view.js';
import type { OrgThread } from './threads-model.js';
import { keepsThreads } from './keeps-threads.js';
import { checkedFor, markChecked } from './thread-checks.js';

export const MAX_SUMMARY_NUDGES = 2;
const nudged = new Map<string, number>();

/** For tests. */
export function resetSummaryNudges(): void { nudged.clear(); }

/** The open threads whose summary his latest message outdated. Pure. */
export function staleSummaries(threads: readonly OrgThread[], nowMs: number): OrgThread[] {
  return threads.filter((t) => !t.closed && t.state !== 'pending' && !snoozedNow(t, nowMs) && summaryBehindHim(t));
}

const lastHisAt = (t: OrgThread) => t.messages.reduce((a, m) => (m.at > a ? m.at : a), '');

/** The node's newest word in a thread: its first post, an answer, its summary. */
function nodeWordAt(t: OrgThread): string {
  let at = t.opener?.at ?? '';
  for (const m of t.messages) if (m.answer && m.answer.at > at) at = m.answer.at;
  const s = t.reply?.trim() ? summaryAt(t) ?? '' : '';
  return s > at ? s : at;
}

/** The node's newest touch on a thread: its newest word, or a known mark it set. */
function nodeTouchAt(t: OrgThread): string {
  const w = nodeWordAt(t);
  const k = t.known?.at ?? '';
  return k > w ? k : w;
}

/** His newest words in the node's chat (not a reply on one card), and the thread they went to. */
function newestOfHis(threads: readonly OrgThread[]): { at: string; thread: OrgThread } | null {
  let best: { at: string; thread: OrgThread } | null = null;
  for (const t of threads) for (const m of t.messages) if (m.via === 'chat' && (!best || m.at > best.at)) best = { at: m.at, thread: t };
  return best;
}

/**
 * The open answered threads whose answer is still news on his card although he wrote in the node's
 * chat after it (his words went to another thread): they may already build on it (he read it), so
 * the node checks each against them. A reply he gave on another card is not one. Pinned and
 * snoozed ones are his to keep. Pure.
 */
export function answeredBeforeHim(threads: readonly OrgThread[], nowMs: number): OrgThread[] {
  const his = newestOfHis(threads);
  if (!his) return [];
  return threads.filter((t) => t.id !== his.thread.id && !t.closed && t.state === 'answered' && !t.pinned && !snoozedNow(t, nowMs)
    && hasThreadNews(t) && nodeWordAt(t) !== '' && nodeTouchAt(t) < his.at);
}

export function answeredBeforeHimReason(threads: readonly OrgThread[], his: { at: string; thread: OrgThread }): string {
  const lines = threads.map((t) => `- ${t.id} ${JSON.stringify(t.title)}: answered ${nodeWordAt(t)}`);
  return `Walnut: the user wrote to you after these answers (his message ${his.at}, filed in ${his.thread.id} ${JSON.stringify(his.thread.title)}), and their cards still show them as unread:\n`
    + `${lines.join('\n')}\n`
    + 'Check each against what he said since. Same subject: merge his message into it (thread_update merge_into). He read it and its work is done: close it (close: acked). '
    + 'He read it and it goes on: mark it known (known: "all") with a summary of where it stands now. Still waiting on him: keep only the one question left. '
    + 'His words did not touch it: leave it as it is.';
}

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
    const { isFollower } = await import('../server-role.js');
    if (isFollower()) return null;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const taskId = (await getSessionByClaudeId(sid).catch(() => null))?.taskId;
    if (!taskId) return null;
    const { listTasksByIds } = await import('../task-manager.js');
    const task = (await listTasksByIds([taskId]).catch(() => []))[0];
    if (!task || !keepsThreads(task) || task.phase === 'COMPLETE') return null;
    const { readThreads } = await import('./threads-store.js');
    const threads = (await readThreads(taskId)).threads;
    const stale = staleSummaries(threads, nowMs)
      .filter((t) => (nudged.get(`${taskId}:${t.id}:${lastHisAt(t)}`) ?? 0) < MAX_SUMMARY_NUDGES)
      .slice(0, 8);
    for (const t of stale) {
      const key = `${taskId}:${t.id}:${lastHisAt(t)}`;
      nudged.set(key, (nudged.get(key) ?? 0) + 1);
    }
    const his = newestOfHis(threads);
    // Once per message of his: a node that checked a thread and left it is not asked again until
    // he writes again. Kept on disk (thread-checks.ts): the server restarts at every deploy.
    let before: OrgThread[] = [];
    if (his) {
      const named = answeredBeforeHim(threads, nowMs);
      const checked = named.length ? await checkedFor(taskId, his.at) : new Set<string>();
      before = named.filter((t) => !checked.has(t.id)).slice(0, 8);
      await markChecked(taskId, before.map((t) => t.id), his.at);
    }
    // A long-running server: forget the oldest names.
    while (nudged.size > 2000) nudged.delete(nudged.keys().next().value as string);
    if (!stale.length && !before.length) return null;
    const reason = [stale.length ? staleSummaryReason(stale) : '', before.length ? answeredBeforeHimReason(before, his!) : ''].filter(Boolean).join('\n\n');
    return { reason, threads: [...stale, ...before].map((t) => t.id) };
  } catch {
    return null;
  }
}
