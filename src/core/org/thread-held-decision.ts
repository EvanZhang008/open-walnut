/**
 * A decision a needs thread of a task carries is that task's to hold, for every teammate whose
 * same ask folds under it (experiment threads_reply_tag; reviews 2026-11-25). A card line puts a
 * decision on a thread (reply-card-decision.ts applyNeedsCard), and a report's ask that is that decision
 * moves there (thread-report-ask.ts askNowOnThread, askOnNeedsThread). A teammate folded under it
 * (same-ask.ts, a decision_owner pointer or the words) then lost its holder and showed the decision
 * again, and his answer on the thread reached only the first task.
 *
 * The decision is known by its id: the thread stores the decision id it carries (OrgThread.askId,
 * a report's `ask-...` id: the task's own when the line asked it, a new one otherwise;
 * thread-report-ask.ts cardDecisionId, markThreadDecision), and a fold keeps the id of the
 * decision it folded under (SameAskFold.decision). With no id on one side (a thread an older build
 * wrote, a fold made before), only the same words in other words count (ask-decision.ts
 * oneDecision), never shared words: two decisions on one subject stay two. The rules, read by every fold:
 *  - the holder still holds the decision while an open needs thread of its own carries it
 *    (decision-owner.ts holds and resolveDecisionOwner, user-status-sync.ts stillAsksOf), whether or
 *    not its report ever asked it or asks another decision now;
 *  - that thread's decision is a fold target for a teammate's same ask, as a shown ask is
 *    (threadRelatives, same-ask-tree.ts relativeAsksIndex);
 *  - his message on THAT thread is his word on it (repliedOnThread), so the fold reads answered
 *    once the thread carries it no more; a message on another thread of the holder is not.
 * Off with the experiment: nothing is read and every fold is as before.
 */
import { isDecisionId, memoryOf, oneDecision } from '../ask-decision.js';
import { askKey, type RelativeAsk } from '../same-ask.js';
import type { Task } from '../types.js';
import type { OrgThread } from './threads-model.js';
import { replyTagNow } from './reply-card-switch.js';

/**
 * One decision a thread of the task carries: the thread, its question, the decision id it stores
 * (absent on one an older build wrote), whether it waits on him for it now, and his newest message
 * of his own there.
 */
export interface ThreadDecision { thread: string; ask: string; id?: string; open: boolean; heAt?: string }

/** What a fold reads of a holder's threads. */
export interface HolderThreads { decisions: ThreadDecision[] }

/** A decision as a fold or a pointer names it: its id, its words, or the key of its words. */
export interface DecisionRef { id?: string; ask?: string; key?: string }

type HolderTask = Pick<Task, 'id' | 'status_report' | 'phase' | 'status'>;

const closed = (t: Pick<Task, 'phase' | 'status'>) => t.phase === 'COMPLETE' || t.status === 'done';

/** Whether this thread decision is the one named: by id when both have one, else its words (oneDecision) or their key. */
function carries(d: ThreadDecision, want: DecisionRef): boolean {
  if (d.id && isDecisionId(want.id)) return d.id.toLowerCase() === want.id.toLowerCase();
  if (want.ask) return oneDecision({ ask: d.ask }, { ask: want.ask });
  return !!want.key && askKey(d.ask) === want.key;
}

/** The id of the holder's own decision in these words (its report's ask, or the one it remembers), if any. */
function reportIdOf(task: HolderTask, ask: string): string | undefined {
  const mem = memoryOf(task.status_report);
  return mem && isDecisionId(mem.id) && askKey(mem.ask) === askKey(ask) ? mem.id : undefined;
}

/**
 * The decision an open needs thread of the task carries now: the one named, or with none named its
 * only one. Null otherwise, and with the experiment off. Pure.
 */
export function decisionOnThread(task: HolderTask | null | undefined, held: HolderThreads | null | undefined, want: DecisionRef | null): ThreadDecision | null {
  if (!task || !held || !replyTagNow() || closed(task)) return null;
  const open = held.decisions.filter((d) => d.open);
  if (!want) return open.length === 1 ? open[0]! : null;
  return open.find((d) => carries(d, want)) ?? null;
}

/** Whether the holder still holds a fold's `ask` (`decision`: the id the fold keeps) on such a thread. Pure. */
export function holdsOnThread(task: HolderTask | null | undefined, held: HolderThreads | null | undefined, ask: string, decision?: string): boolean {
  if (!task) return false;
  const id = decision ?? reportIdOf(task, ask);
  return !!decisionOnThread(task, held, { ...(id ? { id } : {}), ask });
}

/** His newest message of his own on the thread of the holder that carries (or carried) this decision; none on any other thread. Pure. */
export function repliedOnThread(task: HolderTask | null | undefined, held: HolderThreads | null | undefined, ask: string, decision?: string): string | undefined {
  if (!task || !held || !replyTagNow()) return undefined;
  const id = decision ?? reportIdOf(task, ask);
  let at: string | undefined;
  for (const d of held.decisions) if (d.heAt && (!at || d.heAt > at) && carries(d, { ...(id ? { id } : {}), ask })) at = d.heAt;
  return at;
}

/** The decisions its open needs threads carry, as a teammate's fold reads a shown ask (same-ask-tree.ts relativeAsksIndex). Pure. */
export function threadRelatives(task: Pick<Task, 'id' | 'title' | 'created_at' | 'phase' | 'status'>, held: HolderThreads | null | undefined): RelativeAsk[] {
  if (!held || !replyTagNow() || closed(task)) return [];
  return held.decisions.filter((d) => d.open).map((d) => ({
    id: task.id, title: task.title, ask: d.ask, ...(task.created_at ? { createdAt: task.created_at } : {}),
    ...(d.id ? { decision: { id: d.id, key: d.id } } : {}),
  }));
}

/** How a fold's read gets a task's threads: the status sync's kept copy, or the store. */
export type ThreadRows = (task: Task) => Promise<readonly OrgThread[] | null>;

/**
 * Per task, what a fold reads of its threads: each open task whose threads take its asks
 * (sessions/status-threads.ts placesAskOnThread). Empty with the experiment off. Never throws.
 */
export async function holderThreadsOf(tasks: ReadonlyArray<Task | undefined>, rows?: ThreadRows): Promise<Map<string, HolderThreads>> {
  const out = new Map<string, HolderThreads>();
  if (!replyTagNow()) return out;
  try {
    const [{ placesAskOnThread }, { threadDecisionsOf }] = await Promise.all([import('../sessions/status-threads.js'), import('./thread-report-ask.js')]);
    const asking = tasks.filter((t): t is Task => !!t && !closed(t) && placesAskOnThread(t));
    if (!asking.length) return out;
    const read: ThreadRows = rows ?? (async (t) => (await (await import('./threads-store.js')).readThreads(t.id)).threads);
    for (const t of asking) {
      const threads = await read(t).catch(() => null);
      if (threads) out.set(t.id, { decisions: threadDecisionsOf(t, threads) });
    }
  } catch { /* unread: no fold reads a thread */ }
  return out;
}
