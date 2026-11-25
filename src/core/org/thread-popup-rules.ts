/**
 * The pure rules and the switch of the experiment `threads_pop_up` (thread-popup.ts reads the
 * view; threads-store.ts stamps the ask ids on every write). No store import here: the store
 * imports this.
 */
import crypto from 'node:crypto';
import { experimentalEnabled } from '../experimental.js';
import { isDecisionId } from '../ask-decision.js';
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

/**
 * threads_reply_tag: a report's decision id on a thread (OrgThread.askId, thread-report-ask.ts
 * markThreadDecision) names the decision it carries only for the stretch of needs it was written
 * in. A thread that enters needs again in this write leaves the old one behind; the write that puts
 * a decision up names its id again. Pure.
 */
export function dropCarriedDecisions(before: ThreadsFile, after: ThreadsFile): ThreadsFile {
  const was = new Map(before.threads.map((t) => [t.id, t] as const));
  let changed = false;
  const threads = after.threads.map((t) => {
    const prev = was.get(t.id);
    if (!prev || t.closed || t.state !== 'needs' || !isDecisionId(t.askId) || t.askId !== prev.askId) return t;
    if (!prev.closed && prev.state === 'needs') return t;
    changed = true;
    const { askId: _carried, ...rest } = t;
    return rest as OrgThread;
  });
  return changed ? { ...after, threads } : after;
}
