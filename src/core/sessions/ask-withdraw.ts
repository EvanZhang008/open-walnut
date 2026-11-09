/**
 * An answer given in the user's place can be taken back (2026-11-08, the Personal VP's reflection: it
 * answered a task's ask for the user on his words of the day before, found the task's email was one
 * he had since asked for, withdrew the answer in words, and Walnut still kept it: the ask never came
 * back to his Needs you, and only a letter was left).
 *
 * `task_ask_answer_withdraw` (POST /api/v1/tasks/:id/ask-answer/withdraw, and the Withdraw button
 * where the answer shows) removes one answer from Task.asks_answered / ask_answered, so answeredAbove
 * (same-ask.ts) no longer reads the ask answered: while the task's report still asks it, it is back on
 * the user's Needs you at the next status pass. A teammate whose same ask was folded under it and
 * read answered there loses that answer too (foldSameAsk reads Task.asks_withdrawn). Who may: the
 * person, the task that gave the answer, or any task that may answer it (ask-answer.ts standsAbove).
 * A session says why (10+ characters).
 *
 * Each such task is told once, never woken for it while its ask simply returns to the user: a running
 * turn hears it now (it may be acting on the answer); otherwise it rides the task's next message
 * (pendingWithdrawnNote, read by session-message-queue.ts sendMessageToSession from the stored
 * record, so a restart or a late resume keeps it). When the report no longer asks (it took the answer
 * and moved on), a live idle session hears it now, since it may have acted on the answer. A COMPLETE
 * task is never told (a message would reopen it). The record stays (Task.asks_withdrawn).
 */
import { log } from '../../logging/index.js';
import { ambiguousIdMessage, matchIdRef, missingIdMessage } from '../../lib/id-ref.js';
import type { SessionRecord, Task } from '../types.js';
import { isLiveSessionStatus, pickDeliverySession } from '../routines/session-target.js';
import {
  ASKS_WITHDRAWN_MAX, answerFor, answerHolds, answersOf, askKey, type AskAnswer, type AskAnswerWithdrawal,
} from '../same-ask.js';
import { liveDelivery, liveSendGuard, notDeliveredLive, standsAbove } from './ask-answer.js';

export class AskWithdrawError extends Error {
  constructor(readonly code: 'not_above' | 'no_answer' | 'reason' | 'not_found', message: string, readonly status = 409) {
    super(message);
    this.name = 'AskWithdrawError';
  }
}

export interface AskWithdrawResult {
  task: Task;
  withdrawn: AskAnswerWithdrawal;
  /** The task's report still asks it, so it is back on the user's Needs you. */
  needsAgain: boolean;
  /** Teammates whose same ask read answered there, told too. */
  teammates: Array<{ id: string; title: string; told: AskAnswerWithdrawal['told'] }>;
}

/** The answer a withdrawal takes back: the one named by its ask, else the one the status shows, else the newest. Pure. */
export function answerToWithdraw(t: Pick<Task, 'user_status' | 'status_report' | 'ask_answered' | 'asks_answered'>, ask?: string): AskAnswer | null {
  const answers = answersOf(t);
  if (!answers.length) return null;
  if (ask?.trim()) return answerFor(answers, ask) ?? answers.find((a) => a.key === askKey(ask)) ?? null;
  const shown = t.user_status?.answeredFor;
  if (shown) {
    const hit = answers.find((a) => a.at === shown.at && a.key === askKey(shown.ask));
    if (hit) return hit;
  }
  return answerFor(answers, t.status_report?.ask) ?? answers[0];
}

/** Whether the task's own report still asks what `answer` answered (the hold's clock aside). Pure. */
export function reportStillAsks(t: Pick<Task, 'phase' | 'status_report'>, answer: Pick<AskAnswer, 'key' | 'ask' | 'at'>): boolean {
  const r = t.status_report;
  if (t.phase === 'COMPLETE' || r?.state !== 'needs' || !r.ask) return false;
  return answerHolds(answer as AskAnswer, r.ask, Date.parse(answer.at));
}

/** The Walnut note a task hears once. Pure. */
export function withdrawnNoteBody(w: AskAnswerWithdrawal): string {
  const one = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
  const where = w.via
    ? `to the ask of the user that "${one(w.via.title, 80)}" (${w.via.id}) asked, the same as yours, which you were told was answered there`
    : 'to your ask of the user';
  return [
    `${one(w.byTitle, 80)} took back the answer ${one(w.answeredByTitle, 80)} gave in the user's place (${w.answeredAt.slice(0, 16).replace('T', ' ')} UTC) `
      + `${where}: "${one(w.ask, 200)}". The answer was: "${one(w.text, 300)}".`,
    ...(w.reason ? [`Why: ${one(w.reason, 300)}`] : []),
    'Do not act on that answer any more.',
    w.needsAgain
      ? 'The ask is back on the user\'s Needs you: wait for his own answer. If what you ask has changed, ask it again in your status in its new words.'
      : 'If that decision is still open, ask the user it again in your status. If you already acted on the answer, say what you did in that status, so he can decide.',
  ].join('\n');
}

const noteOf = async (w: AskAnswerWithdrawal): Promise<string> => {
  const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
  return buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'answer-withdrawn', note: 'an answer given in the user\'s place was taken back' }, body: withdrawnNoteBody(w) });
};

const sameEntry = (a: AskAnswerWithdrawal, b: AskAnswerWithdrawal) => a.at === b.at && a.key === b.key && a.via?.id === b.via?.id;

/** Keep `w` on the task (oldest first), or change its `told` once it was told. */
async function storeEntry(taskId: string, w: AskAnswerWithdrawal, extra?: (cur: Readonly<Task>) => Partial<Task> | null): Promise<Task | undefined> {
  const { updateTaskRaw } = await import('../task-manager.js');
  const out = await updateTaskRaw(taskId, (cur) => {
    const more = extra ? extra(cur) : {};
    if (more === null) return null;
    const list = (cur.asks_withdrawn ?? []).filter((x) => !sameEntry(x, w));
    return { ...more, asks_withdrawn: [...list, w].slice(-ASKS_WITHDRAWN_MAX) } as Partial<Task>;
  }, { emitEvent: true, source: 'ask-withdraw' });
  return out.task;
}

/**
 * Take back an answer given in the user's place. `callerTaskId` null = the person. `ask`: which ask's
 * answer, when the task holds several (default: the one its status shows).
 */
export async function withdrawAskAnswer(
  callerTaskId: string | null, targetTaskId: string, opts: { ask?: string; reason?: string } = {},
): Promise<AskWithdrawResult> {
  const { listTasks, getTask } = await import('../task-manager.js');
  const everything = await listTasks();
  // The whole id wins over a prefix (src/lib/id-ref.ts); a prefix only when it names one task.
  const matches = matchIdRef(everything, targetTaskId);
  if (matches.length > 1) throw new AskWithdrawError('not_found', ambiguousIdMessage(targetTaskId, matches), 400);
  const target = matches[0];
  if (!target) throw new AskWithdrawError('not_found', missingIdMessage(targetTaskId), 404);
  const answer = answerToWithdraw(target, opts.ask);
  if (!answer) {
    throw new AskWithdrawError('no_answer', `"${target.title}" (${target.id}) holds no answer given in the user's place${opts.ask ? ` to "${opts.ask.slice(0, 120)}"` : ''}: nothing to take back.`);
  }
  const caller = callerTaskId ? everything.find((t) => t.id === callerTaskId) : undefined;
  if (callerTaskId && (!caller || (caller.id !== answer.by && !standsAbove(caller, target, everything)))) {
    throw new AskWithdrawError('not_above',
      `Not withdrawn: only the task that gave the answer, a task "${target.title}" (${target.id}) is under, its lead or VP, Main, or the user takes back an answer given in the user's place.`);
  }
  const reason = (opts.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (caller && reason.length < 10) {
    throw new AskWithdrawError('reason', 'Not withdrawn: say why in reason (10+ characters); the task is told it with the withdrawal.');
  }
  const base = {
    key: answer.key, ask: answer.ask, text: answer.text, answeredBy: answer.by, answeredByTitle: answer.byTitle, answeredAt: answer.at,
    by: caller ? caller.id : 'human', byTitle: caller ? caller.title : 'The user', at: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
  const same = (a: AskAnswer) => a.key === answer.key && a.at === answer.at;
  const needsAgain = reportStillAsks(target, answer);
  const plan = await toldPlan(target, needsAgain);
  const entry: AskAnswerWithdrawal = { ...base, needsAgain, told: plan.told };
  let removed = false;
  // Under the row's lock: only that answer goes, one recorded meanwhile stays.
  const stored = await storeEntry(target.id, entry, (cur) => {
    const before = answersOf(cur);
    const kept = before.filter((a) => !same(a)).reverse();
    if (kept.length === before.length) return null;
    removed = true;
    return {
      asks_answered: kept.length ? kept : null,
      ask_answered: kept.length ? kept[kept.length - 1] : null,
    } as unknown as Partial<Task>;
  });
  if (!removed || !stored) throw new AskWithdrawError('no_answer', `"${target.title}" (${target.id}): that answer was already taken back.`);
  const told = await tellNow(stored, entry, plan.live);

  // Teammates whose same ask was folded under it and read answered there (same-ask.ts).
  const teammates: AskWithdrawResult['teammates'] = [];
  for (const t of everything) {
    const fold = t.user_status?.sameAsk;
    if (t.id === target.id || fold?.id !== target.id || !fold.answered || t.phase === 'COMPLETE') continue;
    const theirs = reportStillAsks(t, { key: fold.key, ask: fold.ask, at: answer.at }) || t.status_report?.state === 'needs';
    const p = await toldPlan(t, theirs);
    const w: AskAnswerWithdrawal = { ...base, needsAgain: theirs, via: { id: target.id, title: target.title }, told: p.told };
    const kept = await storeEntry(t.id, w).catch(() => undefined);
    teammates.push({ id: t.id, title: t.title, told: kept ? await tellNow(kept, w, p.live) : 'not' });
  }

  log.task.info('ask-answer: withdrawn', { taskId: target.id, by: entry.by, answeredBy: answer.by, told, needsAgain, teammates: teammates.length });
  // The status the user reads, derived again now rather than after the sync's debounce (a no-op where it does not run).
  const { settleUserStatusSync } = await import('../user-status-sync.js');
  await settleUserStatusSync().catch(() => {});
  const task = await getTask(target.id).catch(() => stored);
  return { task, withdrawn: { ...entry, told }, needsAgain, teammates };
}

/** How a task hears it: now into a running turn (or an idle one that moved on), else with its next message. */
async function toldPlan(task: Task, stillAsks: boolean): Promise<{ told: AskAnswerWithdrawal['told']; live?: SessionRecord }> {
  if (task.phase === 'COMPLETE') return { told: 'not' };
  const { getSessionsForTask } = await import('../session-tracker.js');
  const sessions = (await getSessionsForTask(task.id).catch(() => [] as SessionRecord[])).filter((s) => !s.archived);
  if (!sessions.length && !task.session_id) return { told: 'not' };
  const live = pickDeliverySession(sessions.filter((s) => isLiveSessionStatus(s.process_status)));
  // 'now' is stored first, so no other message carries it while this one goes.
  if (live && (live.process_status === 'running' || !stillAsks)) return { told: 'now', live };
  return { told: 'next_message' };
}

/** Send it now when the plan says so; a session that stopped meanwhile hears it with its next message. */
async function tellNow(task: Task, w: AskAnswerWithdrawal, live: SessionRecord | undefined): Promise<AskAnswerWithdrawal['told']> {
  if (w.told !== 'now' || !live) return w.told;
  try {
    const guard = await liveSendGuard(await liveDelivery(live.claudeSessionId));
    const { sendMessageToSession } = await import('../session-message-queue.js');
    const { WAIT_UNTIL_SEND_SOURCE } = await import('../task-wait-until.js');
    await sendMessageToSession(live.claudeSessionId, await noteOf(w), { source: WAIT_UNTIL_SEND_SOURCE, taskId: task.id, ...guard });
    return 'now';
  } catch (err) {
    if (!(await notDeliveredLive(err))) throw err;
    await storeEntry(task.id, { ...w, told: 'next_message' }).catch(() => {});
    return 'next_message';
  }
}

/**
 * The withdrawals a session's task has not heard yet, for the message going into it now
 * (session-message-queue.ts), or null. One answered again since is dropped (marked not told). Never throws.
 */
export async function pendingWithdrawnNote(sessionId: string): Promise<{ text: string; markTold: () => Promise<void> } | null> {
  try {
    const { getSessionByClaudeIdSync } = await import('../session-tracker.js');
    const taskId = getSessionByClaudeIdSync(sessionId)?.taskId;
    if (!taskId) return null;
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    const owed = (task?.asks_withdrawn ?? []).filter((w) => w.told === 'next_message');
    if (!task || !owed.length || task.phase === 'COMPLETE') return null;
    const holderOf = async (w: AskAnswerWithdrawal) => (w.via ? await getTask(w.via.id).catch(() => null) : task);
    const live: AskAnswerWithdrawal[] = [];
    const stale: AskAnswerWithdrawal[] = [];
    for (const w of owed) ((answersOf(await holderOf(w)).some((a) => a.key === w.key)) ? stale : live).push(w);
    const mark = async (told: AskAnswerWithdrawal['told'], which: AskAnswerWithdrawal[]) => {
      if (!which.length) return;
      const { updateTaskRaw } = await import('../task-manager.js');
      await updateTaskRaw(task.id, (cur) => ({
        asks_withdrawn: (cur.asks_withdrawn ?? []).map((x) => (x.told === 'next_message' && which.some((y) => sameEntry(x, y)) ? { ...x, told } : x)),
      }) as Partial<Task>, { source: 'ask-withdraw' }).catch(() => {});
    };
    // Answered again since: the newer answer is what it hears, not this.
    await mark('not', stale);
    if (!live.length) return null;
    const text = (await Promise.all(live.map(noteOf))).join('\n\n');
    return { text, markTold: () => mark('now', live) };
  } catch {
    return null;
  }
}
