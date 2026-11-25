/**
 * A decision a task asked, now carried by a thread of its own in needs, is still that task's
 * (experiment threads_reply_tag; review 2026-11-25). When a card line puts the task's decision on a
 * thread, its report stops asking it (thread-report-ask.ts askNowOnThread, askOnNeedsThread) and
 * keeps it as `last_ask`. A teammate whose same ask was folded under it (same-ask.ts, a
 * decision_owner pointer or the words) then lost its holder and showed the decision again, and his
 * answer on the thread reached only the first task. The one rule, read by every fold:
 *  - the holder still holds the decision while an open needs thread of its own asks it
 *    (decision-owner.ts holds and resolveDecisionOwner, user-status-sync.ts stillAsksOf);
 *  - his message on the holder's threads is his word to that task, as one in its chat is
 *    (user-status-sync.ts readFoldEvidence, personInputAt), so the fold reads answered once the
 *    thread asks no more, exactly as after his answer in the holder's chat.
 * Off with the experiment: nothing is read and every fold is as before.
 */
import type { AskMemory } from '../ask-decision.js';
import { sameDecisionWords } from '../ask-decision.js';
import type { Task } from '../types.js';
import { replyTagNow } from './reply-card-switch.js';

/** What a fold reads of a holder's threads: what its open needs threads ask, and when he last wrote on them. */
export interface HolderThreads { asks: string[]; heAt?: string }

/**
 * The decision the task's report asked before an open needs thread of its own took it, while that
 * thread still asks it; null otherwise, and with the experiment off. Pure.
 */
export function decisionOnThread(task: Pick<Task, 'status_report' | 'phase' | 'status'> | null | undefined, held: HolderThreads | null | undefined): AskMemory | null {
  if (!task || !held?.asks.length || !replyTagNow() || task.phase === 'COMPLETE' || task.status === 'done') return null;
  const r = task.status_report;
  // A report asking anything now asks that; the memory is of a decision it no longer asks.
  const mem = r && !r.ask?.trim() ? r.last_ask : undefined;
  return mem && held.asks.some((a) => sameDecisionWords(a, mem.ask)) ? mem : null;
}

/** Whether the holder still holds `ask` on such a thread: the remembered decision in these words. Pure. */
export function holdsOnThread(task: Pick<Task, 'status_report' | 'phase' | 'status'> | null | undefined, held: HolderThreads | null | undefined, ask: string): boolean {
  const mem = decisionOnThread(task, held);
  return !!mem && sameDecisionWords(mem.ask, ask);
}

/**
 * Per task, what a fold reads of its threads (the tasks a fold names; only one whose report
 * remembers a decision it no longer asks can carry one there). Empty with the experiment off.
 * Never throws.
 */
export async function holderThreadsOf(tasks: ReadonlyArray<Task | undefined>): Promise<Map<string, HolderThreads>> {
  const out = new Map<string, HolderThreads>();
  if (!replyTagNow()) return out;
  const asking = tasks.filter((t): t is Task => !!t && !!t.status_report?.last_ask && !t.status_report.ask?.trim());
  if (!asking.length) return out;
  try {
    const [{ readThreads }, { askedOnThreads }] = await Promise.all([import('./threads-store.js'), import('./thread-report-ask.js')]);
    for (const t of asking) {
      const threads = (await readThreads(t.id)).threads;
      let heAt: string | undefined;
      // His own words only: never an agent's reply on his behalf, nor one that never went.
      for (const th of threads) for (const m of th.messages) {
        if (m.delivery?.state === 'dropped' || (m.delivery?.by && m.delivery.by !== 'human') || m.via === 'import') continue;
        if (!heAt || m.at > heAt) heAt = m.at;
      }
      out.set(t.id, { asks: askedOnThreads(t, threads), ...(heAt ? { heAt } : {}) });
    }
  } catch { /* unread: no fold reads a thread */ }
  return out;
}
