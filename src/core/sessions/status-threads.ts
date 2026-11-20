/**
 * The status side question keeps the task's threads current (2026-11-20, the user, approving design
 * "A": "ask it also the actual status of this, if there are multiple thread please ask for multiple
 * thread, then set the status correctly. like in this case, it is basically a waiting status right.
 * also that side question will also maintain the thread, also we prefer the thread instead of inbox").
 *
 * A task that keeps Threads and is no Org node (Main and the leads keep their own thread rules) is
 * shown its open threads by a short ref (t1, t2...) in the status question (status-question.ts
 * askStatus), and answers one FOR_USER_THREAD line per thread, plus FOR_USER_THREAD_NEW for a
 * subject it now follows that no thread covers. Walnut then:
 *  - writes each thread by the task itself (applyThreadLines): working, pending (waiting), answered,
 *    or closed when done and the task opened it (his own request is answered; he closes it);
 *  - sets the task's state from them when FOR_USER_STATE said needs with no ask, or done while a
 *    subject still runs (settleStateFromThreads). A real ask always wins.
 * No line ever moves a thread into needs: what needs the user's decision is FOR_USER_ASK. That ask
 * lives on one of the threads (FOR_USER_ASK_THREAD names it, else Walnut's rule picks it), which
 * reads needs while the task asks it (org/thread-report-ask.ts), so he sees one card for it.
 * The refs live in memory between the question and its answer only, so a thread opened meanwhile
 * never shifts them.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { OUTSIDE_WAIT_KINDS, waitWordsNameUser, type StatusReport } from '../user-status.js';
import { cutEnd } from '../text-cut.js';
import { keepsThreads } from '../org/keeps-threads.js';
import { sortedThreads, THREAD_TITLE_MAX, type OrgThread, type ThreadPatch, type ThreadsFile } from '../org/threads-model.js';
import type { OwnThreadOpen, OwnThreadWrite } from '../org/threads-store.js';
import { hasThreadNews, openNotWaiting } from '../org/thread-view.js';
import { oneCardNow } from '../org/one-card.js';

export type ThreadLineState = 'working' | 'waiting' | 'answered' | 'done';
/** One FOR_USER_THREAD line, its ref resolved to the thread it names. */
export interface StatusThreadLine { id: string; title: string; state: ThreadLineState; progress?: string }
/** One FOR_USER_THREAD_NEW line: a subject the task follows that no thread covers. */
export interface StatusThreadNew { title: string; state: 'working' | 'waiting'; progress?: string }
/** The open threads the question listed, by ref. */
export type ThreadRefs = ReadonlyMap<string, { id: string; title: string }>;

/** Threads listed at most (newest change first): the block costs every status question. */
export const THREAD_LIST_MAX = 12;
export const THREAD_NEW_MAX = 3;
const TITLE_SHOWN_MAX = 60;
const PROGRESS_MAX = 240;

/** Whether the status question asks this task about its threads. */
export function asksThreads(task: Pick<Task, 'org_role' | 'threads_on'> | null | undefined): boolean {
  // Main and every lead keep Threads by their own rules; only another task that keeps them is asked.
  return !!task && !task.org_role && keepsThreads(task);
}

/** The block the status question adds, and the refs it listed. Pure. */
export function threadQuestionBlock(open: readonly Pick<OrgThread, 'id' | 'title' | 'state'>[], langName?: string): { block: string; refs: Map<string, { id: string; title: string }> } {
  const refs = new Map<string, { id: string; title: string }>();
  const listed = open.slice(0, THREAD_LIST_MAX).map((t, i) => {
    const ref = `t${i + 1}`;
    refs.set(ref, { id: t.id, title: t.title });
    const title = t.title.replace(/\s+/g, ' ').trim();
    return `${ref} "${title.slice(0, cutEnd(title, TITLE_SHOWN_MAX))}" (${t.state})`;
  });
  const words = langName ? ` (titles and progress in ${langName})` : '';
  const newLine = `A subject you now follow that no thread covers: FOR_USER_THREAD_NEW: <working | waiting> | <title> | <one line on where it stands> (at most ${THREAD_NEW_MAX}).`;
  const rule = 'What needs the user\'s decision stays on FOR_USER_ASK, never a thread line.';
  // Its ask lives on a thread only with threads_one_card on (org/one-card.ts, thread-report-ask.ts).
  const askLine = oneCardNow() ? ' With a FOR_USER_ASK, the thread it is about: FOR_USER_ASK_THREAD: <ref>.' : '';
  const block = listed.length
    ? `\nThis task's open threads (one per subject the user follows here): ${listed.join('; ')}.\nOne line per thread: FOR_USER_THREAD: <ref> | <working | waiting | answered | done> | <one line on where it stands>${words}. ${newLine} ${rule}${askLine}`
    : `\n${newLine.replace(/\.$/, '')}${words}. ${rule}`;
  return { block, refs };
}

/** What the status question adds for `task`: '' and no refs for a task it does not ask. Never throws. */
export async function threadQuestionFor(task: Pick<Task, 'id' | 'org_role' | 'threads_on'>, langName?: string): Promise<{ block: string; refs: ThreadRefs }> {
  if (!asksThreads(task)) return { block: '', refs: new Map() };
  try {
    const { readThreads } = await import('../org/threads-store.js');
    // A thread waiting on him (needs) is his to move, by his answer or the task's own thread_update:
    // it is not asked, so no line can take it out of his sight (review round 1).
    const open = sortedThreads((await readThreads(task.id)).threads).filter(openNotWaiting);
    return threadQuestionBlock(open, langName);
  } catch {
    return { block: '', refs: new Map() };
  }
}

const LINE_RE = /^[^\S\n]*[*_`]*FOR_USER_THREAD(_NEW)?[*_`]*[^\S\n]*[:\uff1a][*_`]*[^\S\n]*(.*)$/gm;
const ASK_THREAD_RE = /^[^\S\n]*[*_`]*FOR_USER_ASK_THREAD[*_`]*[^\S\n]*[:\uff1a][*_`]*[^\S\n]*(.*)$/m;

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').replace(/[*`]+$/, '').trim();
  return t.slice(0, cutEnd(t, max));
}

function stateWord(raw: string): ThreadLineState | null {
  const w = raw.trim().toLowerCase().replace(/^[*_`"']+|[*_`"'.]+$/g, '');
  return w.startsWith('working') ? 'working' : w.startsWith('waiting') ? 'waiting'
    : w.startsWith('answered') ? 'answered' : w.startsWith('done') ? 'done' : null;
}

/** The thread lines of an answer, by the refs the question listed. Unknown refs and state words are dropped. Pure. */
export function readThreadLines(answer: string, refs: ThreadRefs): Pick<StatusReport, 'threads' | 'threads_new' | 'ask_thread'> {
  const named = refs.get(/^[*_`"'\s]*(t\d+)\b/i.exec(ASK_THREAD_RE.exec(answer)?.[1] ?? '')?.[1].toLowerCase() ?? '');
  const threads = new Map<string, StatusThreadLine>();
  const opened: StatusThreadNew[] = [];
  const known = new Set([...refs.values()].map((r) => r.title.trim().toLowerCase()));
  for (const m of answer.matchAll(LINE_RE)) {
    const parts = m[2].split(/[|\uff5c]/);
    if (m[1]) {
      const state = stateWord(parts[0] ?? '');
      const title = oneLine(parts[1] ?? '', THREAD_TITLE_MAX);
      if ((state !== 'working' && state !== 'waiting') || !title || known.has(title.toLowerCase()) || opened.length >= THREAD_NEW_MAX) continue;
      known.add(title.toLowerCase());
      const progress = oneLine(parts.slice(2).join('|'), PROGRESS_MAX);
      opened.push({ title, state, ...(progress ? { progress } : {}) });
      continue;
    }
    const ref = (parts[0] ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = refs.get(ref);
    const state = stateWord(parts[1] ?? '');
    if (!target || !state || threads.has(target.id)) continue;
    const progress = oneLine(parts.slice(2).join('|'), PROGRESS_MAX);
    threads.set(target.id, { id: target.id, title: target.title, state, ...(progress ? { progress } : {}) });
  }
  return { ...(threads.size ? { threads: [...threads.values()] } : {}), ...(opened.length ? { threads_new: opened } : {}), ...(named ? { ask_thread: named.id } : {}) };
}

/**
 * The task's state from its thread lines (2026-11-20, the user: "then set the status correctly. like
 * in this case, it is basically a waiting status right"). The case: FOR_USER_STATE needs-you with no
 * FOR_USER_ASK read "something to read: It answered your question" while all that was left was a
 * rollout outside. In order:
 *  - a real ask of the user (FOR_USER_ASK, or a wait on the user) always wins, and so does an ask
 *    Walnut already turned into a report to its lead (kindless_ask): unchanged;
 *  - the task's own work going on (working, or waiting on its own build): unchanged;
 *  - any thread working: working;
 *  - else the task's own named wait stands; else any thread waiting: waiting outside, on those threads;
 *  - else (answered or done only): unchanged, as today.
 * Only a state it changes is marked `from_threads` (its answered threads carry what it answered).
 * Pure; the lines stay on the result for the caller to apply.
 */
export function settleStateFromThreads(report: StatusReport): StatusReport {
  const lines = [...(report.threads ?? []), ...(report.threads_new ?? [])];
  if (!lines.length) return report;
  if ((report.state === 'needs' && report.ask?.trim()) || report.kindless_ask) return report;
  // A turn that answered his message keeps answered_person beside this state (status-question.ts):
  // it reads "the answer to read; then it waits on: ..." until he writes again or its next turn of
  // its own parks it (user-status.ts), so the answer is his to read first (2026-10-31, the user: "I
  // have not even read it and it is put into wait") and the wait is named (review round 1).
  // A wait that names him, by its kind or its words, is his (report-phase.ts phaseForReport).
  if (report.state === 'waiting' && (report.waiting_kind === 'you' || waitWordsNameUser(report.waiting_on, !!report.waiting_kind && OUTSIDE_WAIT_KINDS.has(report.waiting_kind)))) return report;
  // Its own work going on is working already, in its own words.
  if (report.state === 'working' || (report.state === 'waiting' && report.waiting_kind === 'own')) return report;
  if (lines.some((l) => l.state === 'working')) return asState(report, 'working');
  if (report.state === 'waiting') return report;
  const waiting = lines.filter((l) => l.state === 'waiting').map((l) => l.title.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!waiting.length) return report;
  const on = waiting.join('; ');
  return { ...asState(report, 'waiting'), waiting_kind: 'outside', waiting_on: on.slice(0, cutEnd(on, PROGRESS_MAX)) };
}

function asState(report: StatusReport, state: 'working' | 'waiting'): StatusReport {
  const { waiting_kind: _k, waiting_on: _o, ask_kind: _ak, ask_options: _ao, ask_more: _am, ask_own: _aw, ...rest } = report;
  return { ...rest, state, from_threads: true };
}

/** The thread state each line writes; done is a close, or answered (patchForLine). */
const TARGET: Record<Exclude<ThreadLineState, 'done'>, OrgThread['state']> = { working: 'working', waiting: 'pending', answered: 'answered' };

/** The write one line makes on its thread, or null for none. Pure. */
export function patchForLine(t: OrgThread, line: StatusThreadLine): ThreadPatch | null {
  // A thread waiting on him stays his until he answers or the task settles it with thread_update:
  // no line moves it, whatever it says (it may have moved into needs since the question was asked).
  if (t.closed || t.state === 'needs') return null;
  const reply = line.progress;
  if (line.state === 'done') {
    // A subject the task opened itself ends closed; his own request is answered, and he closes it.
    if (t.opener && t.opener.by !== 'human') return { close: 'dropped', ...(reply ? { reply } : {}) };
    return same(t, 'answered', reply) ? null : { state: 'answered', ...(reply ? { reply } : {}) };
  }
  let state = TARGET[line.state];
  // An answer he has not read yet keeps the thread in his sight (2026-10-31, the user: "I have not
  // even read it and it is put into wait"): it hides only once he has.
  if (state !== 'answered' && t.state === 'answered' && hasThreadNews(t)) state = 'answered';
  return same(t, state, reply) ? null : { state, ...(reply ? { reply } : {}) };
}

/** Nothing new: the same state and words again never move its clock or its place in the list. */
function same(t: OrgThread, state: OrgThread['state'], reply: string | undefined): boolean {
  return t.state === state && (!reply || (t.reply ?? '').trim() === reply.trim());
}

/** Each line as the write it makes on its thread as it is now (run under the store's lock). Pure. */
export function planThreadWrites(file: ThreadsFile, lines: readonly StatusThreadLine[], opened: readonly StatusThreadNew[]): { writes: OwnThreadWrite[]; opens: OwnThreadOpen[] } {
  const writes: OwnThreadWrite[] = [];
  for (const line of lines) {
    const t = file.threads.find((x) => x.id === line.id);
    const patch = t ? patchForLine(t, line) : null;
    if (!t || !patch) continue;
    // A close its thread refuses (he pinned it, he wrote in it and has not reacted): answered.
    const fallback = patch.close && !same(t, 'answered', line.progress) ? { state: 'answered' as const, ...(line.progress ? { reply: line.progress } : {}) } : undefined;
    writes.push({ id: t.id, patch, ...(fallback ? { fallback } : {}) });
  }
  const opens = opened.map((n) => ({ title: n.title, text: n.progress ?? n.title, state: TARGET[n.state] }));
  return { writes, opens };
}

/**
 * Write the report's thread lines to `taskId`'s threads, by the task, and put the ask the stored
 * report makes (`asks`) on its thread in the same write (org/thread-report-ask.ts). Never throws;
 * returns the threads changed.
 */
export async function applyThreadLines(taskId: string, report: Pick<StatusReport, 'threads' | 'threads_new' | 'ask_thread'>, asks?: StatusReport | null): Promise<string[]> {
  const lines = report.threads ?? [];
  const opened = report.threads_new ?? [];
  const { reportAskOf, placeAsk } = await import('../org/thread-report-ask.js');
  // `asks` given: the task places its ask (or, asking nothing now, takes its places off).
  const ask = asks ? reportAskOf(asks) : undefined;
  if (!lines.length && !opened.length && ask === undefined) return [];
  try {
    const { writeOwnThreads, readThreads } = await import('../org/threads-store.js');
    // Only the ask, and its place would not move: no write.
    if (!lines.length && !opened.length) {
      const cur = await readThreads(taskId);
      if (placeAsk(cur, ask ?? null, new Date().toISOString(), report.ask_thread) === cur) return [];
    }
    const changed = await writeOwnThreads(taskId, (cur) => planThreadWrites(cur, lines, opened), `task:${taskId}`,
      ask !== undefined ? { ask, ...(report.ask_thread ? { named: report.ask_thread } : {}) } : undefined);
    if (changed.length) log.session.info('status question: threads kept current', { taskId, changed });
    return changed;
  } catch (err) {
    log.session.warn('status question: thread lines not applied', { taskId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
