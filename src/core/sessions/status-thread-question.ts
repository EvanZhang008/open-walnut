/**
 * The read side of the status question's thread block (status-threads.ts keeps the block's words
 * and the write side): which of a task's threads the question lists, from its threads file and the
 * memory earlier questions and turns left, and with threads_reminder on when it is the reminder
 * (status-thread-remind.ts). status-threads.ts re-exports these names.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { lastUserAt, sortedThreads, type OrgThread, type ThreadsFile } from '../org/threads-model.js';
import { openNotWaiting, sharedAnswers } from '../org/thread-view.js';
import { ackHoldsResult } from '../org/thread-known.js';
import { linesAreCards } from '../org/threads-kept.js';
import { replyTagNow } from '../org/reply-card-switch.js';
import { joinedToAsk } from './status-thread-split.js';
import { heldTitleOf, nearAll } from './status-thread-title.js';
import { isQuestionThread } from '../org/thread-question.js';
import { cardWords } from './status-thread-card.js';
import { decisionsUpPart, linesThatAsked, markAsks } from './status-thread-asked.js';
import { byNeed, lastListed, noteListed } from './status-thread-pick.js';
import { cardedNow, cardsWritten } from './status-thread-carded.js';
import { lastReminder, noteQuestion, overdueTimes, pickForReminder, reminderDue, reminderOn, type Reminded, type RemindWhy } from './status-thread-remind.js';
import { answersHeWroteAfter, asksThreads, HIS_SHOWN_MAX, staleAskTitle, threadQuestionBlock, type HisWords, type ListedThread, type ThreadRef, type ThreadRefs } from './status-threads.js';

/**
 * The threads as the question lists them, and his messages since the oldest answer he wrote after
 * (newest first). `near`: each untitled thread's possible subjects (nearAll); `besideOnly`: the ones
 * listed only beside such a thread, never for a need of their own (status-thread-pick.ts byNeed). Pure.
 */
export function listForQuestion(file: ThreadsFile, open: readonly OrgThread[], near: ReadonlyMap<string, string[]> = new Map(), besideOnly: ReadonlySet<string> = new Set()): { listed: Array<OrgThread & ListedThread>; his: HisWords[] } {
  const upTo = (t: OrgThread) => t.messages[t.messages.length - 1]?.id ?? '';
  const hisAt = lastUserAt(file) ?? '';
  const hasOf = (t: OrgThread) => {
    const joined = joinedToAsk(t);
    const held = heldTitleOf(file, t);
    return { ...(ackHoldsResult(t) ? { acked: true } : {}), ...(joined ? { joined } : {}), ...(held ? { held } : {}), ...(isQuestionThread(t) ? { own: true } : {}) };
  };
  const shared = sharedAnswers(file.threads);
  const card = (t: OrgThread) => { const c = cardWords(t, shared); return c ? { card: c } : {}; };
  if (!linesAreCards()) return { listed: open.map((t) => ({ ...t, ...hasOf(t), ...card(t), upTo: upTo(t), hisAt })), his: [] };
  let since = '';
  const listed = open.map((t) => {
    const after = answersHeWroteAfter(file, t);
    for (const at of after) if (!since || at < since) since = at;
    const its = t.titled ? undefined : near.get(t.id);
    return { ...t, ...hasOf(t), ...card(t), untitled: !t.titled, ...(staleAskTitle(t) ? { retitle: true } : {}), ...(its ? { near: its } : {}), ...(besideOnly.has(t.id) ? { besideOnly: true } : {}), wrote: after.length > 0 && !besideOnly.has(t.id), upTo: upTo(t), hisAt };
  });
  const his = since
    ? file.threads.flatMap((t) => t.messages.filter((m) => m.at > since).map((m) => ({ threadId: t.id, text: m.text, at: m.at })))
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, HIS_SHOWN_MAX).map(({ threadId, text }) => ({ threadId, text }))
    : [];
  return { listed, his };
}

/**
 * What a question needs besides the task's threads, all kept in memory by earlier questions and
 * turns: the threads the reply's card lines spoke for (status-thread-carded.ts), the lines dropped
 * for asking him (status-thread-asked.ts), when each thread was last listed (status-thread-pick.ts),
 * and with threads_reminder on the task's last reminder (status-thread-remind.ts).
 */
export interface QuestionMemory {
  carded: ReadonlySet<string>;
  dropped: ReadonlySet<string>;
  last: ReadonlyMap<string, number>;
  remind?: { rec: Reminded | undefined; sid?: string; compactedAt?: string };
}

/**
 * The block the status question adds for `task` with these threads, and the refs it listed;
 * `reminded` (threads_reminder on): why it is the reminder, null between reminders, absent when
 * no thread was left to ask about (the question is not counted). Pure.
 */
export function threadQuestionOf(file: ThreadsFile, task: Pick<Task, 'org_role'>, mem: QuestionMemory, langName?: string, now: number = Date.now()): { block: string; refs: Map<string, ThreadRef>; reminded?: RemindWhy | null } {
  // A thread waiting on him (needs) is his to move, by his answer or the task's own thread_update:
  // no line is asked for it, so none can take it out of his sight (review round 1). It is listed
  // only for a message of his joined there by timing, which only this check shows on his card
  // (the threads inspection, item 6: five of his words on a decision card were off it for 13 hours);
  // a line for it writes nothing (patchForLine).
  const asked = (t: OrgThread) => openNotWaiting(t) || (t.state === 'needs' && !t.closed && !t.movedTo && !!joinedToAsk(t));
  const sorted = sortedThreads(file.threads);
  // A thread its reply's card line spoke for this turn is not asked again (org/reply-card.ts); with
  // every one spoken for, the question holds no thread block at all.
  const carded = sorted.filter((t) => asked(t) && mem.carded.has(t.id));
  const open = sorted.filter((t) => asked(t) && !mem.carded.has(t.id));
  if (carded.length && !open.length) return { block: '', refs: new Map() };
  // An untitled thread's possible subjects come with it, a decision waiting on him too (no line is
  // asked for it), listed only right after it (review 2026-11-24: never for a rank of its own).
  const near = linesAreCards() ? nearAll(file, open, now) : new Map<string, string[]>();
  const beside = new Set([...near.values()].flat());
  for (const t of open) beside.delete(t.id);
  const { listed, his } = listForQuestion(file, [...open, ...sorted.filter((t) => beside.has(t.id))], near, beside);
  const marked = markAsks(listed, mem.dropped);
  const org = !!task.org_role;
  // Listed by need first, so the 12 the question names are the ones that need a line (status-thread-pick.ts).
  const spoken = carded.map((t) => ({ id: t.id, title: t.title }));
  if (!mem.remind) return threadQuestionBlock(byNeed(marked, now, mem.last), langName, { org, his, spoken });
  // threads_reminder: the threads that need a line now, and every open one at a reminder.
  const rec = mem.remind.rec;
  const reminded = reminderDue(rec, { sid: mem.remind.sid, now, compactedAt: mem.remind.compactedAt, overdueAt: overdueTimes(open, now) });
  // A reminder by count or by an overdue thread leaves out what the node wrote since the last one;
  // a new session or a compaction lost that, so it gets them all.
  const skipSince = rec && (reminded === 'turns' || reminded === 'overdue') ? rec.at : undefined;
  const { picked, omitted } = pickForReminder(marked, !!reminded, now, mem.last, skipSince);
  // Nothing needs a line: the no-thread block (a task keeps its new-subject line, a node has none).
  if (!reminded && !picked.length) return { ...threadQuestionBlock([], langName, { org, his: [], spoken }), reminded };
  return { ...threadQuestionBlock(byNeed(picked, now, mem.last, { rotate: true }), langName, { org, his, omitted, spoken }), reminded };
}

/**
 * What the status question adds for `task`: '' and no refs for a task it does not ask. `at`: the
 * session asked and its last compaction, which bring the reminder (threads_reminder). Never throws.
 */
export async function threadQuestionFor(task: Pick<Task, 'id' | 'org_role' | 'threads_on'>, langName?: string, at: { sessionId?: string; compactedAt?: string } = {}): Promise<{ block: string; refs: ThreadRefs }> {
  if (!asksThreads(task)) return { block: '', refs: new Map() };
  try {
    const { readThreads } = await import('../org/threads-store.js');
    // The card lines of the turn that just ended are written first (status-thread-carded.ts). A write
    // still running at the bound: nothing counts as spoken for, every thread is asked as before.
    const written = await cardsWritten(at.sessionId);
    if (!written) log.session.warn('status question: card lines still being written, no thread is left out', { taskId: task.id, sessionId: at.sessionId });
    const remindOn = await reminderOn();
    // When the threads were read: a message of his after it is newer than this listing (lineNeed).
    const readAt = Date.now();
    const file = await readThreads(task.id);
    const remind = remindOn ? { rec: lastReminder(task.id), ...(at.sessionId ? { sid: at.sessionId } : {}), ...(at.compactedAt ? { compactedAt: at.compactedAt } : {}) } : undefined;
    const carded = replyTagNow() && written ? cardedNow(task.id, file.threads) : new Set<string>();
    const out = threadQuestionOf(file, task, { carded, dropped: linesThatAsked(task.id, readAt, file.threads), last: lastListed(task.id), ...(remind ? { remind } : {}) }, langName, readAt);
    // Which threads the reply's own lines spoke for, so the log shows what this question did not ask.
    if (carded.size) log.session.info('status question: threads their card line spoke for are left out', { taskId: task.id, sessionId: at.sessionId, leftOut: [...carded], listed: [...out.refs.values()].map((r) => r.id) });
    noteListed(task.id, [...out.refs.values()].map((r) => r.id), readAt);
    if (remind && out.reminded !== undefined) {
      noteQuestion(task.id, at.sessionId, !!out.reminded, readAt);
      if (out.reminded) log.session.info('status question: thread reminder', { taskId: task.id, sessionId: at.sessionId, why: out.reminded, listed: out.refs.size, bytes: Buffer.byteLength(out.block) });
    }
    // The decisions its threads already carry in needs are said once, on their cards (org/thread-report-ask.ts).
    const { askedOnThreads } = await import('../org/thread-report-ask.js');
    return { block: out.block + decisionsUpPart(askedOnThreads(task, file.threads)), refs: out.refs };
  } catch {
    return { block: '', refs: new Map() };
  }
}
