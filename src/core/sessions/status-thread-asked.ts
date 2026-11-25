/**
 * A status line never asks him to decide (2026-11-24, the threads inspection: four live cards in
 * Done asked him to decide, written by status lines, with no buttons and nothing in his Needs you;
 * one asked him to answer again after he had answered five times). A line writes a thread's state
 * and summary, and no line writes needs (it carries no options and no user_kind), so an ask said in
 * one reads as a result. The line is not written (status-threads.ts planThreadWrites), and the next
 * question names the thread and says where a decision goes: FOR_USER_ASK for a task, a thread_update
 * into needs for an Org node. Kept in memory: after a restart the next such line is caught again.
 */
import { asksHimNow } from '../org/thread-summary-content.js';
import { cutEnd } from '../text-cut.js';

/** How long a dropped line is named in the questions that follow. */
const NAMED_MS = 24 * 3_600_000;
const TASKS_MAX = 500;

const asked = new Map<string, Map<string, number>>();

/** Record the threads whose line was dropped for asking, and forget the ones that got a line written. */
export function noteLineAsks(taskId: string, dropped: readonly string[], written: readonly string[], now = Date.now()): void {
  const cur = asked.get(taskId) ?? new Map<string, number>();
  for (const id of written) cur.delete(id);
  for (const id of dropped) cur.set(id, now);
  if (cur.size) asked.set(taskId, cur); else asked.delete(taskId);
  if (asked.size > TASKS_MAX) asked.delete(asked.keys().next().value!);
}

/** The task's threads whose last line asked him and was dropped, newer than NAMED_MS. */
export function linesThatAsked(taskId: string, now = Date.now()): Set<string> {
  const cur = asked.get(taskId);
  return new Set([...(cur ?? new Map<string, number>())].filter(([, at]) => now - at <= NAMED_MS).map(([id]) => id));
}

/** The mark beside such a thread in the question. */
export const ASKED_MARK = 'your last line asked the user to decide and was not written';
/** The mark beside a thread whose stored card asks him to decide outside needs (an older build wrote it; status-thread-pick.ts asks it first). */
export const CARD_ASKS_MARK = 'its card asks the user to decide, with no buttons and outside his Needs you';

/** The rule the question adds when a listed thread carries ASKED_MARK. */
export function askedRule(org: boolean, oneCard: boolean): string {
  const where = org
    ? 'a thread_update into needs, with user_kind and options when he picks among choices'
    : `FOR_USER_ASK, with FOR_USER_ASK_OPTIONS when he picks among choices${oneCard ? ' and FOR_USER_ASK_THREAD: <ref>' : ''}`;
  return `A line that asks the user to decide is never written: his card would read it as a result with no buttons. Ask a decision that still waits on ${where}, and give each marked thread a line with its result only.`;
}

/**
 * The listed threads with their marks: a line dropped for asking (`asked`), else a card stored asking
 * him outside needs (`cardAsks`: an older build wrote it, and only a line or a thread_update can fix
 * it, so the question names it). Pure.
 */
export function markAsks<T extends { id: string; state: string; reply?: string }>(listed: readonly T[], dropped: ReadonlySet<string>): Array<T & { asked?: boolean; cardAsks?: boolean }> {
  return listed.map((t) => (dropped.has(t.id) ? { ...t, asked: true } : t.state !== 'needs' && asksHimNow(t.reply) ? { ...t, cardAsks: true } : t));
}

/** How many decisions already up the question quotes, and how much of each. */
const UP_MAX = 3;
const UP_ASK_MAX = 160;

/**
 * The question's part on the decisions the task's own threads already carry in needs
 * (org/thread-report-ask.ts askedOnThreads; a card line put them up): '' for none. 2026-11-25: a
 * session that had put a decision up with its line said it again as FOR_USER_ASK, and he saw it
 * twice. The question says it is up, so the session need not say it twice; said again all the
 * same, Walnut keeps it on the thread only (askOnNeedsThread). Pure.
 */
export function decisionsUpPart(asks: readonly string[]): string {
  const quoted = asks.slice(0, UP_MAX).map((a) => { const w = a.replace(/\s+/g, ' ').trim(); return `"${w.slice(0, cutEnd(w, UP_ASK_MAX))}"`; });
  if (!quoted.length) return '';
  return `\nYour threads' cards already ask him: ${quoted.join('; ')}. A decision up there stays out of FOR_USER_ASK, which is for another decision only; FOR_USER_STATE is needs-you while one waits on him.`;
}

/** Tests only. */
export function resetLineAsks(): void {
  asked.clear();
}
