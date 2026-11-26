/**
 * A task's own ask lives on its thread (2026-11-20, the user, on a task that keeps Threads: its one
 * thread read "Done" in the Threads pane while the chat above held the task's ask card waiting for
 * his answer, "the same thing shows twice, one says Done and the other waits for him"). For a task
 * the status question asks about its threads and that is no Org node (status-threads.ts placesAskOnThread), what the task asks
 * him IS that thread's needs state: one card, one decision.
 *
 * The place is stored, the state is read. When a report asks him something (a real FOR_USER_ASK,
 * with its decision id), Walnut puts that decision on one open thread (`reportAsk` on it): the one
 * the status answer names (FOR_USER_ASK_THREAD), else the thread his newest message was filed to,
 * else the only open thread, else none (the ask stays a plain ask, as before). On every read
 * (threads-store.ts withTaskAsks) that thread reads `needs`, with `askId` = the decision id, its
 * summary leading with the question, and `heldAsk` beside it, while the task's own Action needed
 * item still asks that decision; the moment it asks no more (his answer, a newer report, a snooze,
 * another decision) the thread reads its stored state again, which its FOR_USER_THREAD lines kept
 * current meanwhile. Nothing is stored as needs, so no phone buzz of its own (the task's ask has
 * its own), no overdue clock of its own (thread-view.ts threadOverdue), and its `needs` count
 * leaves it out (thread-view.ts threadCounts): the task's status already counts it once.
 *
 * Data an older build wrote: a task whose current report asks and whose threads hold no place for
 * that decision gets one at its next status derive (keepAskOnThread, user-status-sync.ts), once. A
 * report that asks nothing any more takes the places off (here at its answer, or at that derive).
 *
 * One decision is shown once, whichever way the session put it up (2026-11-25, the user's strongest
 * complaint in the Threads work: one decision as two cards). With threads_reply_tag on
 * (reply-card-switch.ts) a session puts a decision on a thread itself, with a card line
 * (reply-card.ts), and that thread stores needs. Its status answer then named the same decision as
 * the task's ask, and the place rule, which never puts an ask on a thread that already waits on
 * him, put it on another open thread: one decision on two cards and on the task's own item.
 * The rule: a decision an open thread of the task stores in needs is that thread's (needsThreadOf).
 * The task's ask that is the same decision is no ask of its own, in either order: a status answer
 * that names it is stored asking nothing (askOnNeedsThread), a report that asked it before the
 * line stops asking when the line is written (askNowOnThread), and no place is kept for it
 * (placeAsk). The task still reads Needs you, through the thread (user-status.ts taskThreadNeeds).
 *
 * Which decision a thread carries is stored on it, as the report's decision id (OrgThread.askId,
 * review 2026-11-25): a card line's write names the task's own decision when the line asks it, else
 * a new one (cardDecisionId, markThreadDecision), and askNowOnThread names it on a thread it finds
 * by the words, under the report's id. A report and a thread of the task are one decision by that
 * id, or by the one task's words rule (ask-decision.ts sameOwnDecision: the same content words, or
 * the same question offering the same choices), never by shared words alone. A teammate's fold
 * reads the id (thread-held-decision.ts).
 */
import type { AskOption, StatusReport, UserStatus } from '../user-status.js';
import type { Task } from '../types.js';
import { openNotWaiting, snoozedNow, type ThreadHeldAsk } from './thread-view.js';
import type { OrgThread, ThreadsFile } from './threads-model.js';
import { ASK_MEMORY_MS, isDecisionId, memoryOf, mintAskId, readDeclared, reportDecision, sameOwnDecision, stampSaidDecision, type DecisionWords } from '../ask-decision.js';
import { ownItemOf } from '../action-needed.js';
import { placesAskOnThread } from '../sessions/status-threads.js';
import { askSinceOf } from '../sessions/user-spoke.js';
import { OWN_ASK_FIELDS } from '../sessions/own-ask-write.js';
import { log } from '../../logging/index.js';
import { oneCardNow } from './one-card.js';
import { replyTagNow, replyTagOn } from './reply-card-switch.js';
import { threadAskText } from './thread-task-ask.js';
import type { ThreadDecision } from './thread-held-decision.js';

/** The question kept on the place, for the record. */
const ASK_KEPT_MAX = 400;

/** `since`: when this decision began to be asked (askBegan); absent when unknown. */
export interface TaskAsk { id: string; ask: string; options?: AskOption[]; since?: string }

type AskingTask = Pick<Task, 'id' | 'phase' | 'status' | 'user_status' | 'org_role' | 'threads_on'> & Partial<Pick<Task, 'status_report'>>;

/**
 * The ask the task shows him now, as its Action needed item (action-needed.ts): its id (the
 * decision id) and words; null when it asks nothing of its own, or the ask sleeps (snoozed), went
 * to another task asking the same (sameAsk) or was answered for him. Pure.
 */
export function taskAskNow(t: Pick<Task, 'phase' | 'status' | 'user_status'> | null | undefined): TaskAsk | null {
  if (!t || t.phase === 'COMPLETE' || t.status === 'done') return null;
  const s: UserStatus | undefined = t.user_status ?? undefined;
  if (!s || s.sameAsk || s.answeredFor || s.snoozed) return null;
  const item = (s.actions ?? []).find((i) => i.kind === 'ask') ?? (s.state === 'needs' && s.source === 'session' ? ownItemOf(s) : null);
  if (!item || item.snoozedUntil) return null;
  // Its choices are the thread's (ask-options.ts: one shape wherever a choice is shown).
  const options = item.options ?? item.form?.options;
  return { id: item.id, ask: item.summary, ...(options?.length ? { options } : {}) };
}

/** The decision a stored report asks him: its id and words; null for none, or one another task holds. Pure. */
export function reportAskOf(r: StatusReport | null | undefined): TaskAsk | null {
  const d = reportDecision(r);
  if (!d || !r?.ask?.trim() || r.same_as || r.decision_owner || r.kindless_ask) return null;
  const since = askBegan(r);
  return { id: d.id, ask: r.ask.trim(), ...(since ? { since } : {}) };
}

/**
 * When the decision a report asks began, for its place: the report's own time when the decision is
 * new in it (its ask_since is its own turn's stamp, user-spoke.ts askSinceStamp, which a report
 * written mid-turn gets from the turn before), else the start it keeps from the reports before. Pure.
 */
function askBegan(r: StatusReport): string | undefined {
  const own = askSinceOf({ at: r.at, turn_ended_at: r.turn_ended_at });
  if (!r.ask_since || (own && Date.parse(r.ask_since) >= Date.parse(own))) return r.at;
  return r.ask_since;
}

/** A thread of the task that waits on him for a decision of its own (never a pointer to another task's ask). */
export const asksHim = (t: OrgThread): boolean => !t.closed && !t.movedTo && t.state === 'needs' && !t.askOwner;

/** The decision a thread waits on him for, as the task's own ask is compared with it. */
const threadWords = (t: OrgThread): DecisionWords => ({ id: t.askId, ask: threadAskText(t), ...(t.options?.length ? { options: t.options.map((o) => o.label) } : {}) });

/**
 * A thread and the task's own ask are one decision: by the id both store, else by the one task's
 * words rule (sameOwnDecision). Two ids that differ do not make two decisions here: within one
 * task each place mints its own until they are linked (a line written while the status answer was
 * on its way, reply-card-late-line), and the words rule is the strict one.
 */
function sameAsThread(t: OrgThread, ask: DecisionWords): boolean {
  if (isDecisionId(t.askId) && isDecisionId(ask.id) && t.askId.toLowerCase() === ask.id.toLowerCase()) return true;
  return sameOwnDecision(threadWords(t), ask);
}

/** A report's ask as the threads compare it: its decision id, its words, its choices. */
const reportWords = (r: StatusReport, id: string | undefined): DecisionWords => ({ id, ask: r.ask, ...(r.ask_options?.length ? { options: r.ask_options.map((o) => o.label) } : {}) });

/**
 * The open thread that already carries this decision in needs, or null (threads_reply_tag on
 * only): the one that stores its id, or the one asking it in the one task's words rule
 * (sameAsThread). Pure.
 */
export function needsThreadOf(threads: readonly OrgThread[], ask: DecisionWords | null | undefined): OrgThread | null {
  if (!replyTagNow() || !ask?.ask?.trim()) return null;
  return threads.find((t) => asksHim(t) && sameAsThread(t, ask)) ?? null;
}

/**
 * The decision id a card line's needs write gives its thread (reply-card-decision.ts applyNeedsCard): the
 * task's own decision when the line asks it (its report's ask, or one it stopped asking within
 * ASK_MEMORY_MS), else the one the thread already waits on him for when the line asks that again,
 * else a new one. Pure but for the new id.
 */
export function cardDecisionId(
  before: OrgThread | undefined, card: { ask?: string; options?: readonly string[] }, report: StatusReport | null | undefined, nowMs = Date.now(),
): string {
  const line: DecisionWords = { ask: card.ask, ...(card.options?.length ? { options: card.options } : {}) };
  const own = asksOwn(report) ? memoryOf(report) : null;
  const last = !own && report?.last_ask && nowMs - Date.parse(report.last_ask.at) <= ASK_MEMORY_MS ? report.last_ask : null;
  const mem = own ?? last;
  if (mem && isDecisionId(mem.id) && sameOwnDecision(line, { ask: mem.ask, ...(mem.options?.length ? { options: mem.options } : {}) })) return mem.id;
  if (before && asksHim(before) && isDecisionId(before.askId) && sameOwnDecision(line, threadWords(before))) return before.askId;
  return mintAskId();
}

/**
 * Store on an open needs thread the decision id it carries (threads_reply_tag on only). Quiet but
 * for one change event, so a status pass reads it. Never throws; true when it wrote.
 */
export async function markThreadDecision(taskId: string, threadId: string, id: string): Promise<boolean> {
  if (!replyTagNow() || !isDecisionId(id)) return false;
  try {
    const { writeThreadsFor } = await import('./threads-store.js');
    return await writeThreadsFor(taskId, (cur) => {
      const t = cur.threads.find((x) => x.id === threadId);
      if (!t || !asksHim(t) || t.askId === id) return { file: cur, out: false };
      return { file: { ...cur, threads: cur.threads.map((x) => (x.id === threadId ? { ...x, askId: id } : x)) }, out: true, changed: { kind: 'updated', threadId } };
    });
  } catch {
    return false;
  }
}

/**
 * The decisions the task's threads carry (thread-held-decision.ts): each open needs thread of its
 * own, and each other one that stores a decision id (his answer there is read by it). Pure.
 */
export function threadDecisionsOf(task: Pick<Task, 'org_role' | 'threads_on'> | null | undefined, threads: readonly OrgThread[]): ThreadDecision[] {
  if (!replyTagNow() || !placesAskOnThread(task)) return [];
  const out: ThreadDecision[] = [];
  for (const t of threads) {
    if (t.movedTo) continue;
    const open = asksHim(t);
    const id = isDecisionId(t.askId) ? t.askId : undefined;
    const ask = threadAskText(t)?.trim() ?? '';
    if (open ? !ask : !id) continue;
    let heAt: string | undefined;
    // His own words only: never an agent's reply on his behalf, nor one that never went.
    for (const m of t.messages) {
      if (m.delivery?.state === 'dropped' || (m.delivery?.by && m.delivery.by !== 'human') || m.via === 'import') continue;
      if (!heAt || m.at > heAt) heAt = m.at;
    }
    out.push({ thread: t.id, ask, ...(id ? { id } : {}), open, ...(heAt ? { heAt } : {}) });
  }
  return out;
}

/**
 * The decisions the task's own threads carry in needs now, their words and their decision ids, for
 * the status question (sessions/status-thread-asked.ts decisionsUpPart): none with the experiment
 * off, or for Main and the leads, whose asks never place. Pure.
 */
export function askedOnThreads(task: Pick<Task, 'org_role' | 'threads_on'> | null | undefined, threads: readonly OrgThread[]): Array<{ ask: string; id?: string }> {
  return threadDecisionsOf(task, threads).filter((d) => d.open).map((d) => ({ ask: d.ask, ...(d.id ? { id: d.id } : {}) }));
}

/**
 * The thread an ask goes on, or null: the one named (if it can take it), else the open thread his
 * newest message was filed to, else the only open thread. `since` (when the decision began to be
 * asked): only what he wrote up to then counts, because an ask older than his message is not about
 * it (2026-11-26, a live trial: a session's standing "send me the next one", asked before he wrote,
 * was put on each thread he then opened, and every answered card read Needs you). So his newest
 * message is the newest one not after it, and the only open thread takes it unless every message
 * of his there came after it. A thread named takes it whatever the times. Pure.
 */
export function askThreadFor(threads: readonly OrgThread[], named?: string, since?: string): string | null {
  const began = since ? Date.parse(since) : NaN;
  const before = (at: string) => !Number.isFinite(began) || Date.parse(at) <= began;
  const open = threads.filter(openNotWaiting);
  if (named && open.some((t) => t.id === named)) return named;
  let newest: { id: string; at: string } | null = null;
  for (const t of threads) {
    if (t.movedTo) continue;
    for (const m of t.messages) if (before(m.at) && (!newest || m.at > newest.at)) newest = { id: t.id, at: m.at };
  }
  if (newest && open.some((t) => t.id === newest!.id)) return newest.id;
  return open.length === 1 && (!open[0].messages.length || open[0].messages.some((m) => before(m.at))) ? open[0].id : null;
}

/**
 * The file with `ask` placed on its thread: once per decision (a thread that already holds it keeps
 * it, unless the task now names another), and one decision per task (an older one's place goes).
 * `ask` null: the report asks nothing now, so every place goes (asked again later, it is placed
 * again by the rule); so does an ask a thread in needs already carries (needsThreadOf). The same
 * file when nothing changes. The place moves no clock: nothing he reads changed yet. Pure.
 */
export function placeAsk(file: ThreadsFile, ask: TaskAsk | null, at: string, named?: string): ThreadsFile {
  // A decision a thread already carries in needs is that thread's: no place beside it (needsThreadOf).
  if (ask && needsThreadOf(file.threads, taskAskWords(ask))) ask = null;
  const held = ask ? file.threads.find((t) => t.reportAsk?.id === ask.id) : undefined;
  const namedOk = !!ask && !!named && file.threads.some((t) => t.id === named && openNotWaiting(t));
  const target = !ask ? null : namedOk ? named! : held ? held.id : askThreadFor(file.threads, undefined, ask.since);
  const stale = file.threads.some((t) => t.reportAsk && t.reportAsk.id !== ask?.id);
  if (!stale && (!target || held?.id === target)) return file;
  if (!ask) return { ...file, threads: file.threads.map(withoutPlace) };
  const words = ask.ask.replace(/\s+/g, ' ').trim().slice(0, ASK_KEPT_MAX);
  return {
    ...file,
    threads: file.threads.map((t) => {
      if (t.id === target) return held?.id === target ? t : { ...t, reportAsk: { id: ask.id, at, ...(words ? { ask: words } : {}) } };
      // A thread that holds it and cannot be moved from (no other one takes it) keeps it.
      if (!target && t.reportAsk?.id === ask.id) return t;
      return withoutPlace(t);
    }),
  };
}

/** The task's shown ask as the threads compare it. */
const taskAskWords = (a: TaskAsk): DecisionWords => ({ id: a.id, ask: a.ask, ...(a.options?.length ? { options: a.options.map((o) => o.label) } : {}) });

function withoutPlace(t: OrgThread): OrgThread {
  if (!t.reportAsk) return t;
  const { reportAsk: _gone, ...rest } = t;
  return rest as OrgThread;
}

/**
 * He wrote on the thread after the task asked (his reply on its card, a Follow up, a choice he
 * clicked): he answered, and the task has yet to read it (2026-11-20, the user, on a card that
 * stayed in Needs you after his reply: "why this even keep showing after I replied?"). An agent's
 * reply on his behalf and one that never went (dropped) are not his answer. Pure.
 */
export function repliedSinceAsk(t: Pick<OrgThread, 'messages'>, askedAt: string | undefined): boolean {
  if (!askedAt) return false;
  return t.messages.some((m) => m.at > askedAt && m.delivery?.state !== 'dropped' && (!m.delivery?.by || m.delivery.by === 'human'));
}

/**
 * The threads as he reads them: the one holding the task's ask now reads needs, with that ask's id,
 * its words as the thread's `ask`, its summary leading with the question, and `heldAsk`; every other
 * thread as stored (2026-11-25, a live walk: a thread's own `ask` of an older decision stayed beside
 * the held ask's new choices and id, so its card asked the old question over the new buttons). One he
 * answered since the task asked reads as stored (his message made it working) until the task asks
 * again. With threads_one_card off (one-card.ts) every thread reads as stored: the places are kept, unread.
 */
export function withHeldAsk<T extends OrgThread>(task: AskingTask | null | undefined, threads: readonly T[]): Array<T & { heldAsk?: ThreadHeldAsk }> {
  const ask = oneCardNow() && placesAskOnThread(task) ? taskAskNow(task) : null;
  if (!ask) return [...threads];
  return threads.map((t) => {
    // Put aside by him (its Snoozed section), it reads as stored: the task's own ask still shows where it lives.
    if (!openNotWaiting(t) || t.reportAsk?.id !== ask.id || snoozedNow(t)) return t;
    if (repliedSinceAsk(t, task?.user_status?.at ?? t.reportAsk?.at)) return t;
    const reply = t.reply?.trim() ? t.reply : undefined;
    const heldAsk: ThreadHeldAsk = { id: ask.id, ask: ask.ask, ...(reply ? { reply } : {}), was: t.state };
    return { ...t, state: 'needs' as const, askId: ask.id, ask: ask.ask, reply: reply ? `${ask.ask}\n\n${reply}` : ask.ask, heldAsk, ...(ask.options ? { options: ask.options } : {}) };
  });
}

/**
 * Today's data brought in line (at boot, and when its status is next derived): a task whose shown
 * ask is its current report's, and whose threads hold no place for it, gets the place by the same
 * rule, once per decision; a task whose report asks nothing any more loses its places. Idempotent.
 * Never throws; true when it wrote.
 */
export async function keepAskOnThread(task: AskingTask, threads?: readonly OrgThread[]): Promise<boolean> {
  if (!placesAskOnThread(task)) return false;
  const now = taskAskNow(task);
  const reported = reportAskOf(task.status_report);
  // A status a step behind its report never places an older decision; none at all clears the places.
  const ask = !reported ? null : now?.id === reported.id ? { ...now, ...(reported.since ? { since: reported.since } : {}) } : undefined;
  if (ask === undefined) return false;
  try {
    const store = await import('./threads-store.js');
    const list = threads ?? (await store.readThreads(task.id)).threads;
    // One a thread in needs already carries keeps no place (needsThreadOf): it clears like none.
    const placed = ask && !needsThreadOf(list, taskAskWords(ask)) ? ask : null;
    if (placed ? list.some((t) => t.reportAsk?.id === placed.id) || !askThreadFor(list, undefined, placed.since) : !list.some((t) => t.reportAsk)) return false;
    return await store.placeTaskAsk(task.id, placed);
  } catch {
    return false;
  }
}

/** Every field that makes a report's ask: the ones a session may write itself, and what stamping adds (ask-decision.ts, user-spoke.ts). */
const ASK_FIELDS = [...OWN_ASK_FIELDS, 'ask_rev', 'ask_said', 'ask_since', 'ask_legacy_key'] as const satisfies ReadonlyArray<keyof StatusReport>;

/** The report asking nothing of its own: its state and its other words stay. Pure. */
export function withoutOwnAsk(report: StatusReport): StatusReport {
  const next: StatusReport = { ...report };
  for (const f of ASK_FIELDS) delete next[f];
  return next;
}

/** Whether a report asks him a decision of the task's own (never one it folded under another task's). */
const asksOwn = (r: StatusReport | null | undefined): r is StatusReport => !!r && r.state === 'needs' && !!r.ask?.trim() && !r.same_as && !r.decision_owner;

/**
 * A status answer on its way to the store (sessions/status-question.ts saveStatusAnswer, before its
 * decision is stamped): when its ask is the decision one of the task's threads already carries in
 * needs, it is stored asking nothing, exactly as if the session had left FOR_USER_ASK out. Never throws.
 */
export async function askOnNeedsThread(taskId: string, report: StatusReport): Promise<StatusReport> {
  if (!asksOwn(report) || !(await replyTagOn())) return report;
  try {
    const { readThreads } = await import('./threads-store.js');
    // Before stamping: the decision id is the one the session said, if any.
    const held = needsThreadOf((await readThreads(taskId)).threads, reportWords(report, readDeclared(report.ask_id, undefined).id));
    if (!held) return report;
    log.session.info('status answer: its ask is the decision a thread already carries, kept there only', { taskId, threadId: held.id });
    return withoutOwnAsk(report);
  } catch {
    return report;
  }
}

/**
 * The other order: a thread of the task was just put in needs (a card line, reply-card-decision.ts
 * applyNeedsCard), and its stored report already asked that decision. The report stops asking it
 * now, not at its next status answer (one may never come), remembering the decision so the same
 * ask later keeps its id; its place goes with it. Its times stay, so the turn's own status answer
 * still replaces it. Also run right after a status answer is stored (sessions/status-question.ts):
 * a line written while that answer was on its way (askOnNeedsThread read the threads before it)
 * meets it there, whichever lands last. Nothing is settled for him here: the decision still waits
 * on him, on the thread that asks it, so none of his words can go unread (sessions/user-spoke.ts).
 * Never throws; true when the report changed.
 */
export async function askNowOnThread(taskId: string): Promise<boolean> {
  if (!(await replyTagOn())) return false;
  try {
    const [{ getTask, updateTaskRaw }, store] = await Promise.all([import('../task-manager.js'), import('./threads-store.js')]);
    const task = await getTask(taskId).catch(() => null);
    if (!task || !placesAskOnThread(task) || !asksOwn(task.status_report)) return false;
    const held = needsThreadOf((await store.readThreads(taskId)).threads, reportWords(task.status_report, task.status_report.ask_id));
    if (!held) return false;
    const was = task.status_report;
    const { changed } = await updateTaskRaw(taskId, (cur) => {
      // Another report came meanwhile: that one is judged when it is stored (status-question.ts runs this again then).
      if (cur.phase === 'COMPLETE' || cur.status === 'done' || cur.status_report?.at !== was.at || cur.status_report?.ask !== was.ask) return null;
      // Asking nothing of its own, stamped as every report is (ask-decision.ts): the decision stays as last_ask.
      return { status_report: stampSaidDecision(withoutOwnAsk(cur.status_report), cur.status_report) };
    }, { emitEvent: true, source: 'status-report' });
    if (!changed) return false;
    log.task.info('reply card lines: the task\'s own ask is the decision the line put up, kept on its thread only', { taskId, threadId: held.id });
    // The thread carries the report's decision from now on, under the report's id: the one a
    // teammate's fold or pointer named (thread-held-decision.ts).
    if (isDecisionId(was.ask_id) && held.askId !== was.ask_id) await markThreadDecision(taskId, held.id, was.ask_id);
    await store.placeTaskAsk(taskId, null);
    return true;
  } catch {
    return false;
  }
}
