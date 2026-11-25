/**
 * The pure rules and the switch of the experiment `threads_pop_up` (thread-popup.ts reads the
 * view; threads-store.ts stamps the ask ids on every write). No store import here: the store
 * imports this.
 */
import crypto from 'node:crypto';
import { experimentalEnabled } from '../experimental.js';
import { isDecisionId, mintAskId, sameOwnDecision } from '../ask-decision.js';
import { threadAskText } from './thread-task-ask.js';
import type { OrgThread, ThreadsFile } from './threads-model.js';

let popUp = false;
/** The experiment as last read (user-status-sync.ts sets it on every config change). */
export function setThreadsPopUp(on: boolean): void { popUp = on; }
export function threadsPopUpNow(): boolean { return popUp; }

/** The experiment, read from the config now (a route right after Settings changed it agrees); the store's own checks read the value it leaves. */
export async function threadsPopUpOn(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    popUp = experimentalEnabled((await getConfig()).experimental, 'threads_pop_up');
  } catch { /* the last value read stands */ }
  return popUp;
}

/**
 * Each thread that entered needs gets a new decision id; one still in needs keeps its id while
 * its ask is only reworded (2026-11-09, one decision shows once). Pure but for the random ids.
 */
export function stampAskIds(before: ThreadsFile, after: ThreadsFile): ThreadsFile {
  const was = new Map(before.threads.map((t) => [t.id, t] as const));
  let changed = false;
  const threads = after.threads.map((t) => {
    if (t.closed || t.state !== 'needs') return t;
    const prev = was.get(t.id);
    // The decision id of a report this write put on it (threads_reply_tag, thread-report-ask.ts
    // markThreadDecision) is the decision it carries: kept.
    if (isDecisionId(t.askId) && t.askId !== prev?.askId) return t;
    // A thread that came in with its record (a move) keeps the id it carries.
    const entered = prev ? !!prev.closed || prev.state !== 'needs' : !t.askId;
    const id = (entered ? undefined : prev?.askId ?? t.askId) ?? `ak-${crypto.randomBytes(5).toString('hex')}`;
    if (id === t.askId) return t;
    changed = true;
    return { ...t, askId: id };
  });
  return changed ? { ...after, threads } : after;
}

/** A thread's question and choices, as one task's decision is compared (ask-decision.ts sameOwnDecision). */
const questionOf = (t: OrgThread) => ({ ask: threadAskText(t), ...(t.options?.length ? { options: t.options.map((o) => o.label) } : {}) });

/**
 * threads_reply_tag: a report's decision id on a thread (OrgThread.askId, thread-report-ask.ts
 * markThreadDecision) names the decision it carries only while the thread asks that decision. Run
 * on every write of a threads file (threads-store.ts mutateThreads, the one place one is written),
 * so every writer is held to it: a thread_update, a card line, a status line, a merge, Walnut's own
 * writes.
 *  - A thread that enters needs again leaves the old id behind; the write that puts a decision up
 *    names its id again.
 *  - A thread that stays in needs and now asks another question (its `ask`; not the same decision in one
 *    task's words rule) gets a new id: a teammate folded under the first decision is shown it
 *    again, and his answer to the second is never read as an answer to the first (review
 *    2026-11-25, N1: the fence height kept its id after the thread asked the gate colour).
 * Pure but for the new id.
 */
export function keepThreadDecisions(before: ThreadsFile, after: ThreadsFile, mint: () => string = mintAskId): ThreadsFile {
  const was = new Map(before.threads.map((t) => [t.id, t] as const));
  let changed = false;
  const threads = after.threads.map((t) => {
    const prev = was.get(t.id);
    if (!prev || t.closed || t.state !== 'needs' || !isDecisionId(t.askId) || t.askId !== prev.askId) return t;
    const stayed = !prev.closed && prev.state === 'needs';
    if (stayed) {
      // A question only in its summary (no `ask` written either time) is not judged: a summary's
      // first line is no stable question.
      if (!prev.ask?.trim() && !t.ask?.trim()) return t;
      const asked = questionOf(prev);
      const asks = questionOf(t);
      if ((asked.ask ?? '').trim() === (asks.ask ?? '').trim() || sameOwnDecision(asked, asks)) return t;
      changed = true;
      return { ...t, askId: mint() };
    }
    changed = true;
    const { askId: _carried, ...rest } = t;
    return rest as OrgThread;
  });
  return changed ? { ...after, threads } : after;
}
