/**
 * Which open threads the status question lists (2026-11-24, the threads inspection: the question
 * listed the 12 threads changed last, and each line it got moved them first again, so the same 12
 * were rewritten every turn while his VP held 91 open threads; one that needed a line, his words
 * unanswered or overdue, was never asked). The question still lists THREAD_LIST_MAX, picked by
 * need first (needRank), newest within a need. Below the needs (a reaction to ask about, the rest)
 * the ones listed longest ago come first, never listed first of all, so the places left go round:
 * a line that changes nothing writes nothing, so newest first would list the same ones again. A
 * thread with a held title brings the thread it reads like right after it, so their merge is asked.
 * Pure, but for the record of when each thread was last listed (in memory, per task).
 */
import { summaryBehindHim, summaryOwed, threadOverdue } from '../org/thread-view.js';
import { asksHimNow } from '../org/thread-summary-content.js';
import type { OrgThread } from '../org/threads-model.js';

type Pickable = OrgThread & { asked?: boolean; joined?: unknown; held?: { like: string }; wrote?: boolean; untitled?: boolean; retitle?: boolean };

/** Ranks from here on are no need of a line: they go round by when they were listed last. */
const ROUND = 6;
const TASKS_MAX = 500;
const listedAt = new Map<string, Map<string, number>>();

/**
 * How much a thread needs a line now: lower is more. His words on the thread after its summary
 * come before a mere reaction to check: on his VP (2026-11-24) "he wrote elsewhere since an answer
 * here" held for 68 of 91 threads, his words on the thread itself for 10. A card an older build
 * stored asking him to decide out of his Needs you is asked first, as a dropped line is
 * (status-thread-asked.ts; the tidy check reads the same words, thread-capture.ts).
 */
export function needRank(t: Pickable, now: number): number {
  if (t.asked || (t.state !== 'needs' && asksHimNow(t.reply))) return 0;
  if (t.joined || t.held) return 1;
  if (summaryBehindHim(t)) return 2;
  if (threadOverdue(t, now)) return 3;
  if (summaryOwed(t)) return 4;
  if (t.untitled || t.retitle) return 5;
  if (t.wrote) return 6;
  return 7;
}

/** When the question last listed each of the task's threads. */
export function lastListed(taskId: string): ReadonlyMap<string, number> {
  return listedAt.get(taskId) ?? new Map();
}

/** Record the threads a question listed. */
export function noteListed(taskId: string, ids: readonly string[], now: number = Date.now()): void {
  const cur = listedAt.get(taskId) ?? new Map<string, number>();
  for (const id of ids) cur.set(id, now);
  listedAt.set(taskId, cur);
  if (listedAt.size > TASKS_MAX) listedAt.delete(listedAt.keys().next().value!);
}

/** `listed` (newest first) by need first, newest within a need, the rest by when last listed. Pure. */
export function byNeed<T extends Pickable>(listed: readonly T[], now: number = Date.now(), last: ReadonlyMap<string, number> = new Map()): T[] {
  const rows = listed.map((t, i) => ({ t, i, r: needRank(t, now), seen: last.get(t.id) ?? -1 }));
  const sorted = rows.sort((a, b) => Math.min(a.r, ROUND) - Math.min(b.r, ROUND)
    || (a.r >= ROUND ? a.seen - b.seen || a.r - b.r : a.r - b.r) || a.i - b.i).map((x) => x.t);
  // A held title's thread is asked beside the one it reads like (status-thread-title.ts).
  const out: T[] = [];
  const placed = new Set<string>();
  const byId = new Map(sorted.map((t) => [t.id, t] as const));
  for (const t of sorted) {
    if (placed.has(t.id)) continue;
    out.push(t);
    placed.add(t.id);
    const like = t.held ? byId.get(t.held.like) : undefined;
    if (like && !placed.has(like.id)) { out.push(like); placed.add(like.id); }
  }
  return out;
}

/** Tests only. */
export function resetListed(): void {
  listedAt.clear();
}
