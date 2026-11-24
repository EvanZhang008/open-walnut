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
 *    or closed when done and the task opened it (his own request is answered; he closes it); one whose
 *    result he acknowledged only closes on done, and no other line writes it (org/thread-known.ts lineMay);
 *  - sets the task's state from them when FOR_USER_STATE said needs with no ask, or done while a
 *    subject still runs (settleStateFromThreads). A real ask always wins.
 * No line ever moves a thread into needs: what needs the user's decision is FOR_USER_ASK. That ask
 * lives on one of the threads (FOR_USER_ASK_THREAD names it, else Walnut's rule picks it), which
 * reads needs while the task asks it (org/thread-report-ask.ts), so he sees one card for it.
 * The refs live in memory between the question and its answer only, so a thread opened meanwhile
 * never shifts them.
 */
import { log } from '../../logging/index.js';
import { asksHimNow, summaryPointsElsewhere, summaryRepeatsHim } from '../org/thread-summary-content.js';
import { newSubjectsOnly } from '../org/thread-same-subject.js';
import type { Task } from '../types.js';
import { OUTSIDE_WAIT_KINDS, waitWordsNameUser, type StatusReport } from '../user-status.js';
import { cutEnd } from '../text-cut.js';
import { keepsThreads } from '../org/keeps-threads.js';
import { sortedThreads, THREAD_TITLE_MAX, type OrgThread, type ThreadPatch, type ThreadsFile } from '../org/threads-model.js';
import type { OwnThreadOpen, OwnThreadWrite } from '../org/threads-store.js';
import { exchangesOf, hasThreadNews, openNotWaiting, sharedAnswers } from '../org/thread-view.js';
import { ackHoldsResult, lineMay } from '../org/thread-known.js';
import { lastUserAt, reactedSince } from '../org/threads-model.js';
import { oneCardNow } from '../org/one-card.js';
import { threadsKeptNow } from '../org/threads-kept.js';
import { markerRe } from './status-marker.js';
import { joinedToAsk, JOINS_ASKED_MAX, readSplitLines, splitQuestionPart, type JoinedMessage } from './status-thread-split.js';
import { heldTitleOf, MERGE_UNTITLED_LINE, MERGES_ASKED_MAX, mergeQuestionPart, readMergeLines, type HeldTitle } from './status-thread-title.js';
import { answerSteps } from './status-thread-pre.js';
import { CARD_KEEPS_LINE, cardPart, cardWords, keepsCardWords } from './status-thread-card.js';
import { ASKED_MARK, CARD_ASKS_MARK, askedRule, linesThatAsked, markAsks, noteLineAsks } from './status-thread-asked.js';
import { byNeed, lastListed, noteListed } from './status-thread-pick.js';

/** The states a FOR_USER_THREAD line names (stateWord reads them). */
export const THREAD_LINE_STATES = ['working', 'waiting', 'answered', 'done'] as const;
export type ThreadLineState = typeof THREAD_LINE_STATES[number];
/**
 * One FOR_USER_THREAD line, its ref resolved to the thread it names. `upTo`: the thread's newest
 * message (its id, '' for none) when the question listed it: a thread he wrote in since is not
 * written from an answer that never saw his new words (planThreadWrites).
 */
export interface StatusThreadLine { id: string; title: string; state: ThreadLineState; progress?: string; upTo?: string; hisAt?: string }
/** One FOR_USER_THREAD_NEW line: a subject the task follows that no thread covers. */
export interface StatusThreadNew { title: string; state: 'working' | 'waiting'; progress?: string }
/** The open threads the question listed, by ref: `untitled` still under Walnut's stand-in title, `wrote` he wrote since an answer it holds. */
export type ThreadRefs = ReadonlyMap<string, ThreadRef>;
export interface ThreadRef { id: string; title: string; untitled?: boolean; wrote?: boolean; upTo?: string; hisAt?: string; joined?: string; mergeInto?: string }
/**
 * One thread as the question lists it (threadsKeptNow marks `untitled` and `wrote`): `upTo` its
 * newest message then, `hisAt` his newest message in any thread then (a reaction is judged on it).
 */
export type ListedThread = Pick<OrgThread, 'id' | 'title' | 'state'> & { untitled?: boolean; wrote?: boolean; upTo?: string; hisAt?: string; acked?: boolean; joined?: JoinedMessage; held?: HeldTitle; card?: string; asked?: boolean; cardAsks?: boolean };
/** The report's fields the thread lines fill (readThreadLines), each written to the threads, never stored with the report. */
export const THREAD_REPORT_KEYS = ['threads', 'threads_new', 'ask_thread', 'thread_titles', 'threads_seen', 'threads_split', 'joins_checked', 'threads_merge', 'merges_checked'] as const;
export type ThreadReportKey = typeof THREAD_REPORT_KEYS[number];

/** The report's thread fields taken off it (status-question.ts stores the rest), and the rest. Pure. */
export function takeThreadFields(report: StatusReport): { lines: Pick<StatusReport, ThreadReportKey>; rest: StatusReport } {
  const rest: StatusReport = { ...report };
  const lines: Record<string, unknown> = {};
  for (const k of THREAD_REPORT_KEYS) {
    if (rest[k] !== undefined) lines[k] = rest[k];
    delete rest[k];
  }
  return { lines: lines as Pick<StatusReport, ThreadReportKey>, rest };
}
/** A message of his newer than an answer he may have reacted to, for the question to quote. */
export interface HisWords { threadId: string; text: string }

/** What the question says of a thread whose result he acknowledged (org/thread-known.ts lineMay): what a line still does there. */
const ACKED_WORDS = 'he acknowledged its result: a line only closes it (done); news for him is your thread_update';

/** Threads listed at most (newest change first): the block costs every status question. */
export const THREAD_LIST_MAX = 12;
export const THREAD_NEW_MAX = 3;
const TITLE_SHOWN_MAX = 60;
const PROGRESS_MAX = 240;
/** His newer messages the question quotes, and how much of each. */
const HIS_SHOWN_MAX = 3;
const HIS_TEXT_MAX = 80;

/**
 * Whether the status question asks this task about its threads: a task that keeps them, and with
 * threads_kept_by_walnut on (org/threads-kept.ts) Main and every lead too, whose threads it then keeps.
 */
export function asksThreads(task: Pick<Task, 'org_role' | 'threads_on'> | null | undefined): boolean {
  if (!task || !keepsThreads(task)) return false;
  return !task.org_role || threadsKeptNow();
}

/** Whether its status answer's ask lives on one of its threads (org/thread-report-ask.ts): Main and the leads ask him with thread_update into needs. */
export function placesAskOnThread(task: Pick<Task, 'org_role' | 'threads_on'> | null | undefined): boolean {
  return !!task && !task.org_role && keepsThreads(task);
}

/**
 * The block the status question adds, and the refs it listed. `org`: Main's or a lead's (no new
 * subjects; its asks go into needs by thread_update). With threads_kept_by_walnut on, the line is
 * the thread's summary, an untitled thread is named, and a reaction of his is asked. Pure.
 */
export function threadQuestionBlock(open: readonly ListedThread[], langName?: string, opts: { org?: boolean; his?: readonly HisWords[] } = {}): { block: string; refs: Map<string, ThreadRef> } {
  const kept = threadsKeptNow();
  const refs = new Map<string, ThreadRef>();
  const joins: Array<{ ref: string; joined: JoinedMessage }> = [];
  const merges: Array<{ ref: string; held: HeldTitle; likeRef: string }> = [];
  const shown = open.slice(0, THREAD_LIST_MAX);
  const refById = new Map(shown.map((t, i) => [t.id, `t${i + 1}`]));
  const listed = shown.map((t, i) => {
    const ref = `t${i + 1}`;
    // A held title is asked only beside the thread it reads like (review: never one he cannot see named).
    const likeRef = t.held ? refById.get(t.held.like) : undefined;
    const held = t.held && likeRef && merges.length < MERGES_ASKED_MAX ? t.held : undefined;
    if (held) merges.push({ ref, held, likeRef: likeRef! });
    // Asked again by its title when its other thread is not listed; not while it waits its turn.
    const untitled = t.untitled && !held && !(t.held && likeRef);
    const marks = kept ? { ...(untitled ? { untitled: true } : {}), ...(t.wrote ? { wrote: true } : {}) } : {};
    const joined = t.joined && joins.length < JOINS_ASKED_MAX ? t.joined : undefined;
    if (joined) joins.push({ ref, joined });
    refs.set(ref, { id: t.id, title: t.title, ...marks, ...(t.upTo !== undefined ? { upTo: t.upTo } : {}), ...(t.hisAt !== undefined ? { hisAt: t.hisAt } : {}), ...(joined ? { joined: joined.messageId } : {}), ...(held ? { mergeInto: held.like } : {}) });
    const title = t.title.replace(/\s+/g, ' ').trim();
    const said = [t.state, ...(t.acked ? [ACKED_WORDS] : []), ...(marks.untitled ? ['untitled'] : []), ...(marks.wrote ? ['he wrote elsewhere since your answer here'] : []), ...(t.asked ? [ASKED_MARK] : t.cardAsks ? [CARD_ASKS_MARK] : [])].join(', ');
    return `${ref} "${title.slice(0, cutEnd(title, TITLE_SHOWN_MAX))}" (${said}${t.acked ? '' : cardPart(t.card)})`;
  });
  const words = langName ? ` (titles and progress in ${langName})` : '';
  const split = [splitQuestionPart(joins, words), mergeQuestionPart(merges)].filter(Boolean).map((x) => `\n${x}`).join('');
  const asked = shown.some((t) => t.asked || t.cardAsks) ? `\n${askedRule(!!opts.org, oneCardNow())}` : '';
  if (kept) return { block: keptBlock(listed, refs, words, !!opts.org, opts.his ?? []) + asked + split, refs };
  const newLine = `A subject you now follow that no thread covers: FOR_USER_THREAD_NEW: <working | waiting> | <title> | <one line on where it stands> (at most ${THREAD_NEW_MAX}).`;
  const rule = 'What needs the user\'s decision stays on FOR_USER_ASK, never a thread line.';
  // Its ask lives on a thread only with threads_one_card on (org/one-card.ts, thread-report-ask.ts).
  const askLine = oneCardNow() ? ' With a FOR_USER_ASK, the thread it is about: FOR_USER_ASK_THREAD: <ref>.' : '';
  const block = listed.length
    ? `\nThis task's open threads (one per subject the user follows here): ${listed.join('; ')}.\nOne line per thread: FOR_USER_THREAD: <ref> | <working | waiting | answered | done> | <one line on where it stands>${words}. ${CARD_KEEPS_LINE} ${newLine} ${rule}${askLine}`
    : `\n${newLine.replace(/\.$/, '')}${words}. ${rule}`;
  return { block: block + asked + split, refs };
}

/** The block with threads_kept_by_walnut on: the line is what his card says, so it says how to write it. */
function keptBlock(listed: readonly string[], byRef: ReadonlyMap<string, ThreadRef>, words: string, org: boolean, his: readonly HisWords[]): string {
  const refs = [...byRef.values()];
  const newLine = `A subject you now follow that none of these threads covers (one subject is one thread: a subject one covers is its line): FOR_USER_THREAD_NEW: <working | waiting> | <title> | <one line on where it stands> (at most ${THREAD_NEW_MAX}).`;
  if (!listed.length) return org ? '' : `\n${newLine.replace(/\.$/, '')}${words}. What needs the user's decision stays on FOR_USER_ASK, never a thread line.`;
  const parts = [
    `\nThis task's open threads (one per subject the user follows here): ${listed.join('; ')}.`,
    `One line per thread, which Walnut writes as its state and the summary on his card: FOR_USER_THREAD: <ref> | <working | waiting | answered | done> | <where it stands for him, latest first, readable alone by someone who never saw this chat: the result or the question itself (name the task by its title and where it stands, never only that it was given, sent or told), then at most one sentence of background; a proof's path or URL when there is one>${words}.`
      + ` working: you are on it now; waiting: a team or something outside has it (both hidden from him); answered: the result he asked for is in (shown to him); done: finished, or nothing left for him. ${CARD_KEEPS_LINE}`,
  ];
  if (refs.some((r) => r.untitled)) parts.push(`Each untitled thread gets a short title: FOR_USER_THREAD_TITLE: <ref> | <title>.${refs.length > 1 ? ` ${MERGE_UNTITLED_LINE}` : ''}`);
  if (refs.some((r) => r.wrote)) {
    // His own words, so the reaction is judged against what he said, never against a label (review round 1).
    const refOfId = new Map([...byRef].map(([ref, r]) => [r.id, ref]));
    const quoted = his.slice(0, HIS_SHOWN_MAX).map((w) => `${refOfId.get(w.threadId) ?? 'another thread'}: "${oneLine(w.text, HIS_TEXT_MAX)}"`);
    parts.push(`${quoted.length ? `His messages since, newest first: ${quoted.join('; ')}. ` : ''}Of the threads he wrote elsewhere since, the ones whose answer he reacted to in those words (a reply about it, an ok or thanks, a follow-up that builds on it; unsure: not seen): one line, refs only, FOR_USER_THREAD_SEEN: <ref>, <ref>. Leave the line out when none. Walnut marks that answer known, and closes a done one.`);
  }
  if (!org) parts.push(newLine);
  parts.push(org
    ? 'What needs his decision is a thread_update into needs (with user_kind), never a thread line.'
    : `What needs the user's decision stays on FOR_USER_ASK, never a thread line.${oneCardNow() ? ' With a FOR_USER_ASK, the thread it is about: FOR_USER_ASK_THREAD: <ref>.' : ''}`);
  return parts.join('\n');
}

/** The answers on `t` not known yet that he wrote to the node after (thread-capture.ts threadsTidyOf, its `reacted`). Pure. */
function answersHeWroteAfter(file: ThreadsFile, t: OrgThread): string[] {
  return exchangesOf(t).filter((x) => !!x.answer && !x.known && reactedSince(file, x.answer)).map((x) => x.answer!.at);
}

/** He wrote to the node after an answer on `t` that is not known yet. Pure. */
export function wroteSinceAnswer(file: ThreadsFile, t: OrgThread): boolean {
  return answersHeWroteAfter(file, t).length > 0;
}

/** The threads as the question lists them, and his messages since the oldest answer he wrote after (newest first). Pure. */
export function listForQuestion(file: ThreadsFile, open: readonly OrgThread[]): { listed: Array<OrgThread & ListedThread>; his: HisWords[] } {
  const upTo = (t: OrgThread) => t.messages[t.messages.length - 1]?.id ?? '';
  const hisAt = lastUserAt(file) ?? '';
  const hasOf = (t: OrgThread) => {
    const joined = joinedToAsk(t);
    const held = heldTitleOf(file, t);
    return { ...(ackHoldsResult(t) ? { acked: true } : {}), ...(joined ? { joined } : {}), ...(held ? { held } : {}) };
  };
  const shared = sharedAnswers(file.threads);
  const card = (t: OrgThread) => { const c = cardWords(t, shared); return c ? { card: c } : {}; };
  if (!threadsKeptNow()) return { listed: open.map((t) => ({ ...t, ...hasOf(t), ...card(t), upTo: upTo(t), hisAt })), his: [] };
  let since = '';
  const listed = open.map((t) => {
    const after = answersHeWroteAfter(file, t);
    for (const at of after) if (!since || at < since) since = at;
    return { ...t, ...hasOf(t), ...card(t), untitled: !t.titled, wrote: after.length > 0, upTo: upTo(t), hisAt };
  });
  const his = since
    ? file.threads.flatMap((t) => t.messages.filter((m) => m.at > since).map((m) => ({ threadId: t.id, text: m.text, at: m.at })))
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, HIS_SHOWN_MAX).map(({ threadId, text }) => ({ threadId, text }))
    : [];
  return { listed, his };
}

/** What the status question adds for `task`: '' and no refs for a task it does not ask. Never throws. */
export async function threadQuestionFor(task: Pick<Task, 'id' | 'org_role' | 'threads_on'>, langName?: string): Promise<{ block: string; refs: ThreadRefs }> {
  if (!asksThreads(task)) return { block: '', refs: new Map() };
  try {
    const { readThreads } = await import('../org/threads-store.js');
    // A thread waiting on him (needs) is his to move, by his answer or the task's own thread_update:
    // it is not asked, so no line can take it out of his sight (review round 1).
    const file = await readThreads(task.id);
    const { listed, his } = listForQuestion(file, sortedThreads(file.threads).filter(openNotWaiting));
    // Listed by need first, so the 12 the question names are the ones that need a line (status-thread-pick.ts).
    const marked = markAsks(listed, linesThatAsked(task.id));
    const out = threadQuestionBlock(byNeed(marked, Date.now(), lastListed(task.id)), langName, { org: !!task.org_role, his });
    noteListed(task.id, [...out.refs.values()].map((r) => r.id));
    return out;
  } catch {
    return { block: '', refs: new Map() };
  }
}

const LINE_RE = markerRe('FOR_USER_THREAD(_NEW)?', 'gm');
const ASK_THREAD_RE = markerRe('FOR_USER_ASK_THREAD', 'm');
const TITLE_RE = markerRe('FOR_USER_THREAD_TITLE', 'gm');
const SEEN_RE = markerRe('FOR_USER_THREAD_SEEN', 'm');
const refOf = (raw: string): string => raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

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
export function readThreadLines(answer: string, refs: ThreadRefs): Pick<StatusReport, ThreadReportKey> {
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
    const target = refs.get(refOf(parts[0] ?? ''));
    const state = stateWord(parts[1] ?? '');
    if (!target || !state || threads.has(target.id)) continue;
    const progress = oneLine(parts.slice(2).join('|'), PROGRESS_MAX);
    threads.set(target.id, { id: target.id, title: target.title, state, ...(progress ? { progress } : {}), ...(target.upTo !== undefined ? { upTo: target.upTo } : {}), ...(target.hisAt !== undefined ? { hisAt: target.hisAt } : {}) });
  }
  // A title only for a thread the question named untitled, a reaction only where he wrote since an answer.
  const titles = new Map<string, ThreadMark>();
  for (const m of answer.matchAll(TITLE_RE)) {
    const [ref, ...rest] = m[1].split(/[|\uff5c]/);
    const target = refs.get(refOf(ref ?? ''));
    const title = oneLine(rest.join('|'), THREAD_TITLE_MAX);
    if (target?.untitled && title && !titles.has(target.id)) titles.set(target.id, markOf(target, { title }));
  }
  const seen = new Map<string, ThreadMark>();
  for (const ref of seenRefs(SEEN_RE.exec(answer)?.[1] ?? '')) {
    const target = refs.get(ref);
    if (target?.wrote && !seen.has(target.id)) seen.set(target.id, markOf(target));
  }
  return {
    ...(threads.size ? { threads: [...threads.values()] } : {}), ...(opened.length ? { threads_new: opened } : {}), ...(named ? { ask_thread: named.id } : {}),
    ...(titles.size ? { thread_titles: [...titles.values()] } : {}), ...(seen.size ? { threads_seen: [...seen.values()] } : {}),
    ...readSplitLines(answer, refs, { ref: refOf, state: stateWord, text: oneLine, titleMax: THREAD_TITLE_MAX, progressMax: PROGRESS_MAX }),
    ...readMergeLines(answer, refs, refOf, threads.size > 0),
  };
}

/** A title or a reaction for one listed thread, with its newest message then. */
export interface ThreadMark { id: string; upTo?: string; hisAt?: string; title?: string }
const markOf = (r: ThreadRef, more: { title?: string } = {}): ThreadMark => ({ id: r.id, ...(r.upTo !== undefined ? { upTo: r.upTo } : {}), ...(r.hisAt !== undefined ? { hisAt: r.hisAt } : {}), ...more });

/**
 * The refs of a FOR_USER_THREAD_SEEN line, only when the whole line is a list of refs (review round
 * 1: "none (t2 unsure)" and "not t1" named refs the model was not sure of). Anything else, words
 * around a ref included, names none: unsure is unseen.
 */
export function seenRefs(raw: string): string[] {
  const v = raw.replace(/[*_`]/g, '').trim().replace(/[.\u3002]$/, '').trim();
  if (!/^t\d+(?:\s*[,\uff0c\u3001;\uff1b\s]\s*t\d+)*$/i.test(v)) return [];
  return [...new Set(v.toLowerCase().match(/t\d+/g) ?? [])];
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

/** A subject the task opened itself, not his request. */
const nodeOpened = (t: OrgThread): boolean => !!t.opener && t.opener.by !== 'human';

/** The thread state each line writes; done is a close, or answered (patchForLine). */
const TARGET: Record<Exclude<ThreadLineState, 'done'>, OrgThread['state']> = { working: 'working', waiting: 'pending', answered: 'answered' };

/**
 * A line's words as a card's summary, or undefined: words that only say the answer was given
 * elsewhere, or say his own message back, are no summary (org/thread-summary-content.ts; 2026-11-23,
 * a card that read only "the summary was given to you"). Every write of a line's words goes through
 * here: its summary, the close of his acknowledged request and its fallback, a new subject's first
 * post (the threads inspection, item 7: those three wrote the words unchecked). Pure.
 */
export function lineWords(t: Pick<OrgThread, 'messages'> | undefined, words: string | undefined): string | undefined {
  if (!words) return undefined;
  return summaryPointsElsewhere(words) || summaryRepeatsHim(words, (t?.messages ?? []).map((m) => m.text)) ? undefined : words;
}

/** The write one line makes on its thread, or null for none. Pure. */
export function patchForLine(t: OrgThread, line: StatusThreadLine): ThreadPatch | null {
  // A thread waiting on him stays his until he answers or the task settles it with thread_update:
  // no line moves it, whatever it says (it may have moved into needs since the question was asked).
  if (t.closed || t.state === 'needs') return null;
  // Words that say nothing on their own leave the card as it was.
  const reply = lineWords(t, line.progress);
  // He acknowledged its result (org/thread-known.ts ackHoldsResult; 2026-11-23, cards back "New
  // since you acknowledged" every turn): a done line closes it, his Acknowledge covering it, its
  // words on the closed card; any other line writes nothing (real news is the node's thread_update).
  if (ackHoldsResult(t)) return line.state === 'done' ? { close: 'acked', ...(reply ? { reply } : {}) } : null;
  // Words dropped: the state stays too, so a card never moves into his sight with an older summary
  // (review 2026-11-23); the next question asks for the line again.
  if (line.progress && !reply) return null;
  if (line.state === 'done') {
    // A subject the task opened itself ends closed; his own request is answered, and he closes it.
    if (nodeOpened(t)) return { close: 'dropped', ...(reply ? { reply } : {}) };
    return same(t, 'answered', reply) ? null : { state: 'answered', ...(reply ? { reply } : {}) };
  }
  let state = TARGET[line.state];
  // An answer he has not read yet keeps the thread in his sight (2026-10-31, the user: "I have not
  // even read it and it is put into wait"): it hides only once he has.
  if (state !== 'answered' && t.state === 'answered' && hasThreadNews(t)) state = 'answered';
  // A thread the task parked itself stays parked (2026-11-22, a task that set pending four times
  // with thread_update: each status answer said "working" because its land was still queued, and
  // the 30-minute overdue clock nagged it five times). Both states are out of his sight, and a line
  // cannot tell "on it for him now" from "my own work runs", so it never undoes a pending it did
  // not set itself (lineState): his next message, a result (answered, done) or the task's own
  // thread_update moves it. A pending an earlier answer set moves as the answer says (the task took
  // the subject up again). Its words still go on, quietly, as pending.
  if (state === 'working' && t.state === 'pending' && !t.lineState) state = 'pending';
  // Progress words never go over a result he has not read (status-thread-card.ts).
  const words = keepsCardWords(t, state, TARGET[line.state]) ? undefined : reply;
  if (same(t, state, words)) return null;
  const patch = { state, ...(words ? { reply: words } : {}) };
  return lineMay(t, patch) ? patch : null;
}

/** Nothing new: the same state and words again never move its clock or its place in the list. */
function same(t: OrgThread, state: OrgThread['state'], reply: string | undefined): boolean {
  return t.state === state && (!reply || (t.reply ?? '').trim() === reply.trim());
}

/** What the answer said beside its lines (threads_kept_by_walnut): titles for untitled threads, the threads whose answer he reacted to. */
export interface ThreadMarks { titles?: readonly ThreadMark[]; seen?: readonly ThreadMark[] }

/**
 * He wrote in it (or a merge brought words in) since the question listed it: the answer never saw
 * them, so nothing of it is written there (review round 1: a short new request read as his "ok"
 * and closed the thread). A line or mark with no `upTo` (an older caller) is not fenced.
 */
function movedSince(t: OrgThread, upTo: string | undefined): boolean {
  return upTo !== undefined && (t.messages[t.messages.length - 1]?.id ?? '') !== upTo;
}

/**
 * He wrote anywhere since the question (review round 2: "wait, the login page is broken" filed in
 * another thread): a reaction the answer read in his earlier words may be taken back by these, so
 * no known mark and no close from it. Its state and summary lines still go on.
 */
function wroteSinceQuestion(file: ThreadsFile, hisAt: string | undefined): boolean {
  return hisAt !== undefined && (lastUserAt(file) ?? '') !== hisAt;
}

/**
 * Each line as the write it makes on its thread as it is now (run under the store's lock): first a
 * title it was asked for, then the known mark of an answer he reacted to (Walnut's own check of
 * the timing still holds: threads-model.ts knownThrough), then the line. A done line on his own
 * request he reacted to, still answered, closes it as acknowledged (checkClose still decides).
 * Nothing is written to a thread that waits on him, is closed, or has words of his newer than the
 * question. Pure.
 */
export function planThreadWrites(file: ThreadsFile, lines: readonly StatusThreadLine[], opened: readonly StatusThreadNew[], marks: ThreadMarks = {}): { writes: OwnThreadWrite[]; opens: OwnThreadOpen[]; held: string[]; asked: string[] } {
  const writes: OwnThreadWrite[] = [];
  // Lines that wrote nothing on a thread whose result he acknowledged (logged by applyThreadLines).
  const held: string[] = [];
  // Lines that asked him to decide, written nowhere (status-thread-asked.ts).
  const asked: string[] = [];
  const open = (m: ThreadMark) => {
    const t = file.threads.find((x) => x.id === m.id);
    return t && !t.closed && t.state !== 'needs' && !movedSince(t, m.upTo) ? t : undefined;
  };
  for (const m of marks.titles ?? []) {
    const t = open(m);
    if (t && !t.titled && m.title) writes.push({ id: t.id, patch: { title: m.title } });
  }
  const seen = new Set((marks.seen ?? []).filter((m) => !!open(m) && !wroteSinceQuestion(file, m.hisAt)).map((m) => m.id));
  for (const id of seen) writes.push({ id, patch: { known: 'all' } });
  for (const line of lines) {
    const found = file.threads.find((x) => x.id === line.id);
    const t = found && !movedSince(found, line.upTo) ? found : undefined;
    if (t && asksHimNow(line.progress)) { asked.push(t.id); continue; }
    const own = t && line.state === 'done' && !ackHoldsResult(t) && seen.has(t.id) && !wroteSinceQuestion(file, line.hisAt) && t.state === 'answered' && !nodeOpened(t);
    const words = lineWords(t, line.progress);
    const patch = own ? { close: 'acked' as const, ...(words ? { reply: words } : {}) } : t ? patchForLine(t, line) : null;
    if (t && !patch && ackHoldsResult(t)) held.push(t.id);
    if (!t || !patch) continue;
    // A close its thread refuses (he pinned it, he wrote in it and has not reacted): answered, with
    // words that say something (a fallback with none keeps the card's summary). One whose result he
    // acknowledged keeps what he has (lineMay).
    const back = { state: 'answered' as const, ...(words ? { reply: words } : {}) };
    const fallback = patch.close && !same(t, 'answered', words) && lineMay(t, back) ? back : undefined;
    writes.push({ id: t.id, patch, ...(fallback ? { fallback } : {}) });
  }
  // A new subject's words that ask him, or say nothing on their own, are not its first post either: it opens with its title (status-thread-asked.ts).
  const opens = opened.map((n) => ({ title: n.title, text: n.progress && !asksHimNow(n.progress) ? lineWords(undefined, n.progress) ?? n.title : n.title, state: TARGET[n.state] }));
  return { writes, opens, held, asked };
}

/**
 * Write the report's thread lines to `taskId`'s threads, by the task, and put the ask the stored
 * report makes (`asks`) on its thread in the same write (org/thread-report-ask.ts). Never throws;
 * returns the threads changed.
 */
export async function applyThreadLines(taskId: string, report: Pick<StatusReport, ThreadReportKey>, asks?: StatusReport | null): Promise<string[]> {
  // One subject is one thread (org/thread-same-subject.ts): a new subject whose title repeats an open
  // thread of the task is that thread's line; one of another task's opens nothing (that task keeps it).
  const sorted = report.threads_new?.length ? await newSubjectsOnly(taskId, report.threads_new) : null;
  const opened = sorted?.fresh ?? [];
  const named = new Set((report.threads ?? []).map((l) => l.id));
  const lines = [...(report.threads ?? []), ...(sorted?.own ?? []).filter((o) => !named.has(o.id)).map((o) => ({ id: o.id, title: o.item.title, state: o.item.state, ...(o.item.progress ? { progress: o.item.progress } : {}) }))];
  if (sorted?.elsewhere.length) log.session.info('status question: new subjects kept elsewhere', { taskId, kept: sorted.elsewhere.map((e) => ({ title: e.item.title, thread: e.id, task: e.taskId })) });
  const marks: ThreadMarks = { ...(report.thread_titles?.length ? { titles: report.thread_titles } : {}), ...(report.threads_seen?.length ? { seen: report.threads_seen } : {}) };
  const marked = !!(marks.titles || marks.seen);
  const joins = report.joins_checked?.length ? report.joins_checked : null;
  const checks = !!(report.merges_checked?.length || report.threads_merge?.length);
  const { reportAskOf, placeAsk } = await import('../org/thread-report-ask.js');
  // `asks` given: the task places its ask (or, asking nothing now, takes its places off).
  const ask = asks ? reportAskOf(asks) : undefined;
  if (!lines.length && !opened.length && !marked && !joins && !checks && ask === undefined) return [];
  try {
    const { writeOwnThreads, readThreads } = await import('../org/threads-store.js');
    // Only the ask, and its place would not move: no write.
    if (!lines.length && !opened.length && !marked && !joins && !checks) {
      const cur = await readThreads(taskId);
      if (placeAsk(cur, ask ?? null, new Date().toISOString(), report.ask_thread) === cur) return [];
    }
    // Its joins, held titles and new titles first, in the same write (status-thread-pre.ts): a line
    // then speaks for what each thread holds now.
    const by = `task:${taskId}` as const;
    const lang = joins ? await (await import('../human-inbox/walnut-letters/languages.js')).walnutLetterLanguage() : 'en';
    const steps = answerSteps(report, marks, by, lang);
    let held: string[] = [];
    let asked: string[] = [];
    let written: string[] = [];
    const changed = await writeOwnThreads(taskId, (cur) => {
      const a = steps.after(lines, marks);
      const p = planThreadWrites(cur, a.lines, opened, a.marks);
      held = p.held;
      asked = p.asked;
      written = p.writes.map((w) => w.id);
      return p;
    }, by, ask !== undefined ? { ask, ...(report.ask_thread ? { named: report.ask_thread } : {}) } : undefined, steps.pre);
    const did = steps.done();
    if (did.opened.length) log.session.info('status question: joined messages split into threads of their own', { taskId, opened: did.opened });
    if (did.merged.length || did.held.length) log.session.info('status question: repeated titles held or merged', { taskId, merged: did.merged, held: did.held });
    if (changed.length) log.session.info('status question: threads kept current', { taskId, changed });
    if (held.length) log.session.info('status question: lines left out on threads whose result he acknowledged', { taskId, held });
    noteLineAsks(taskId, asked, written);
    if (asked.length) log.session.info('status question: lines that asked the user to decide, not written', { taskId, asked });
    return changed;
  } catch (err) {
    log.session.warn('status question: thread lines not applied', { taskId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
