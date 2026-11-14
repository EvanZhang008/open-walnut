/**
 * A lead, VP or Main answers a task's question to the user in the user's place (task_send
 * `answers_ask`; 2026-11-04, a VP's reflection: Main had decided six questions for the user and
 * written them into the lead's record, and the lead still sat in Needs you with them).
 *
 * Before the send: the caller must stand above the asking task (a task it is under, its lead or VP,
 * Main, or the person), and the task must hold an ask of the user now; the message is led by one
 * Walnut line telling the asker its ask was answered and taken off the user's list (the one time
 * it is told). After the send: the answer is recorded on the asker (Task.ask_answered), so the shown
 * status (same-ask.ts answeredAbove) is no longer Needs you while it asks the same, whatever its
 * next report repeats.
 *
 * An answer never starts work the task is not doing (2026-11-06, the org reflection: a VP answered
 * the ask of a task whose session had stopped, and within 90 s it woke, pushed two commits and armed
 * a second trigger the VP then had to clean up). Only an open task whose session's CLI is alive takes
 * the answer as a message (`answerReach`); a COMPLETE task, or one with no session running, has it
 * recorded and taken off the user's Needs you, and nothing more: work there needs a task_start.
 *
 * An answer in the user's place never goes against what he already wrote in that task unseen
 * (2026-11-07, Main's reflection: Main said "local only" after his "submit the cr"): the answering
 * task is shown his words there, and one he wrote after the ask appeared refuses the answer until
 * it passes them back in user_words (user-spoke.ts).
 */
import { log } from '../../logging/index.js';
import { needsUsersWords } from '../approval-kinds.js';
import { settlerFor, SettleError, type SettledVia } from './ask-settle.js';
import { asksPerson } from '../approvals/ask-me.js';
import { isLocalDraftAsk, isTeamCodeAsk } from '../org/user-kind.js';
import { ambiguousIdMessage, matchIdRef, missingIdMessage } from '../../lib/id-ref.js';
import type { SessionRecord, Task } from '../types.js';
import { isLiveSessionStatus } from '../routines/session-target.js';
import { briefTeam } from '../user-status.js';
import { settleCheck, type UserSaid } from './user-spoke.js';
import { reportDecision } from '../ask-decision.js';
import { askAnswerLine, askKey, keptAnswers, type AskAnswer, type SameAskFold } from '../same-ask.js';

export class AskAnswerError extends Error {
  constructor(readonly code: 'not_above' | 'no_open_ask' | 'user_words' | 'user_spoke_since' | 'bad_request' | 'human_approval' | 'not_confirmed', message: string, readonly status = 409) {
    super(message);
    this.name = 'AskAnswerError';
  }
}

/**
 * Where an ask the user's Needs you shows lives, so an answer in his place settles it there:
 *  - `report`: the session's own question, its status report (FOR_USER line);
 *  - `chat`: an org node's own question, folded into its chat (user-status.ts asOrgNode);
 *  - `choice`: a Board choice, answered on its Board (boards/board-choice-answer.ts);
 *  - `prompt`: a prompt open in its session: an AskUserQuestion is answered, any other tool's
 *    prompt is denied with the answer as its message (a grant stays the person's);
 *  - `letter`: an open decision letter, answered (or settled) in the inbox with its own checks.
 * Every source of a Needs you line is placed here or named as no question
 * (tests/core/sessions/answers-ask-every-need-ratchet.test.ts).
 */
export type AskWhere = 'report' | 'chat' | 'choice' | 'prompt' | 'letter';

export type OpenAsk = { ask: string; where: AskWhere; choice?: { board: string; id: string } } | { none: string };

/**
 * The question to the user this task shows now, and where it lives, or why there is none to
 * answer here: an ask shown on another task (a fold) is answered there, where the user sees it.
 */
export function openAskOf(t: Pick<Task, 'user_status' | 'status_report'>): OpenAsk {
  const us = t.user_status;
  if (us?.sameAsk) return { none: `its ask shows on "${us.sameAsk.title}" (${us.sameAsk.id}), which asks the user the same: answer that task` };
  if (us?.state === 'needs' && us.ask) {
    if (us.source === 'session') return { ask: us.ask, where: 'report' };
    if (us.source === 'choice') return us.choice ? { ask: us.ask, where: 'choice', choice: { ...us.choice } } : { none: 'its Board choice names no Board: answer it on the Board (board_get)' };
    if (us.source === 'prompt') return { ask: us.ask, where: 'prompt' };
    if (us.source === 'letter') return { ask: us.ask, where: 'letter' };
    if (us.source === 'error') return { none: `its Needs you is a failure only the user can clear ("${us.ask.slice(0, 160)}"), not a question: once it is fixed, retry it (task_restart)` };
  }
  // An org node's own question, folded into its chat: settled where it lives (its report, a choice, a prompt, a letter).
  if (us?.state === 'waiting' && us.kind === 'you' && us.chatAsk) {
    const from = us.chatAskFrom;
    if (from === 'choice') return us.choice ? { ask: us.chatAsk, where: 'choice', choice: { ...us.choice } } : { none: 'its Board choice names no Board: answer it on the Board (board_get)' };
    return { ask: us.chatAsk, where: from ?? 'chat' };
  }
  const r = t.status_report;
  if (r?.state === 'needs' && r.ask && (us?.snoozed?.ask || us?.answeredFor || us?.transient || us?.state === 'working')) return { ask: r.ask, where: 'report' };
  if (us?.toRead) return { none: 'it asks nothing: it has a result for the user to read (complete it with task_complete once it is done)' };
  return { none: 'it asks the user nothing now' };
}

/**
 * A COMPLETE task reads Done, so its ask is the one its last report still asked, if any: answered,
 * it is recorded (a reopened task asking it again stays off Needs you), and never delivered.
 */
function finishedAskOf(t: Pick<Task, 'status_report'>): OpenAsk {
  const r = t.status_report;
  if (r?.state === 'needs' && r.ask) return { ask: r.ask, where: 'report' };
  return { none: 'it is complete and asks the user nothing (a message would reopen it; task_start it only if it must work again)' };
}

/** Whether `caller` stands above `target`: a task it is under, Main, or a lead or VP whose team holds it. Pure. */
export function standsAbove(caller: Task, target: Task, everything: readonly Task[]): boolean {
  if (caller.id === target.id) return false;
  if (caller.org_role === 'main') return true;
  const byId = new Map(everything.map((t) => [t.id, t] as const));
  let cur = target.parent_task_id ? byId.get(target.parent_task_id) : undefined;
  for (let hops = 0; cur && hops < 12 && cur.id !== target.id; hops++) {
    if (cur.id === caller.id) return true;
    cur = cur.parent_task_id ? byId.get(cur.parent_task_id) : undefined;
  }
  return caller.org_role === 'lead' && briefTeam(caller, everything).some((t) => t.id === target.id);
}

/** Whether an answer for the user may be delivered as a message, or why it is only recorded. */
export type AnswerReach = { wakes: true } | { wakes: false; why: 'complete' | 'stopped' };

/**
 * Whether an answer for the user reaches the asking task as a message: only an open task with a
 * session whose CLI is alive (running or idle), so no answer ever resumes a stopped session or
 * reopens a finished task. The explicit ways to have it act on the answer: task_start, or `force`
 * with a reason (which leads the message, and reopens a COMPLETE task). Pure.
 */
export function answerReach(
  task: Pick<Task, 'phase'>,
  sessions: ReadonlyArray<Pick<SessionRecord, 'process_status' | 'archived'>>,
  opts: { force?: boolean } = {},
): AnswerReach {
  if (opts.force === true) return { wakes: true };
  if (task.phase === 'COMPLETE') return { wakes: false, why: 'complete' };
  return sessions.some((s) => !s.archived && isLiveSessionStatus(s.process_status)) ? { wakes: true } : { wakes: false, why: 'stopped' };
}

/** The one live session an answer was checked against, and its stop fence when it was checked. */
export interface LiveDelivery { sid: string; stopFence: string | null }

/** The answer's session was no longer the live one it was checked against when its row was stored. */
export class AnswerNotLiveError extends Error {
  constructor(readonly sid: string) { super(`session ${sid.slice(0, 8)} no longer takes the answer live`); this.name = 'AnswerNotLiveError'; }
}

/** The gate's check, read again where the row is stored (sendMessageToSession's stillWanted, stopFence). */
export async function liveDelivery(sid: string): Promise<LiveDelivery> {
  const { sessionStops } = await import('./session-stop.js');
  return { sid, stopFence: await sessionStops.fence(sid) };
}

/** The send options that keep an answer from going into a session that stopped since it was checked. */
export async function liveSendGuard(live: LiveDelivery): Promise<{ stopFence: string | null; stillWanted: () => boolean }> {
  const { getSessionByClaudeIdSync } = await import('../session-tracker.js');
  return {
    // A Stop confirmed after the check supersedes the row (enqueueMessage, and the runner's dispatch).
    stopFence: live.stopFence,
    // Read synchronously right before the row is stored: no await between it and the write.
    stillWanted: () => {
      const rec = getSessionByClaudeIdSync(live.sid);
      return !!rec && !rec.archived && isLiveSessionStatus(rec.process_status);
    },
  };
}

/** Whether a send failed only because its session was no longer live (nothing was queued). */
export async function notDeliveredLive(err: unknown): Promise<boolean> {
  if (err instanceof AnswerNotLiveError) return true;
  const { SendNoLongerWantedError } = await import('../session-message-queue.js');
  const { isSessionStopSuperseded } = await import('./session-stop.js');
  return err instanceof SendNoLongerWantedError || isSessionStopSuperseded(err);
}

/** The decision the answered ask carries (ask-decision.ts), recorded on the answer: its id and key. */
function decisionOfAsk(target: Task, ask: string): Pick<AskAnswer, 'askId' | 'decisionKey'> {
  const r = target.status_report;
  if (r?.state !== 'needs' || askKey(r.ask) !== askKey(ask)) return {};
  const d = reportDecision(r, target.due_date);
  return d ? { askId: d.id, decisionKey: d.key } : {};
}

export interface PreparedAnswer {
  /** Walnut's line that leads the answer: the one time the asker is told. */
  line: string;
  /** The asking task, as the answer found it. */
  target: Pick<Task, 'id' | 'title' | 'phase'>;
  /** What the user wrote in it, shown to the task that answers (user-spoke.ts); absent for the person's own answer. */
  userSaid?: UserSaid;
  /** Record it on the asker once the message is queued. */
  commit: () => Promise<void>;
  /** Where the ask lives (openAskOf). */
  where: AskWhere;
  /** For an ask that lives outside the task's report (a Board choice, a prompt, a letter): settle it
   *  there instead of sending a message (ask-settle.ts). */
  settle?: () => Promise<SettledVia>;
}

/**
 * Check an `answers_ask` send and shape its text. `callerTaskId` null = a person (their own answer).
 * `targetTaskId` is the task the message goes to (with in_reply_to, the request's asker).
 * `callerSessionId`: the resolved caller session's id (never a request field), kept on the answer.
 */
export async function prepareAskAnswer(
  callerTaskId: string | null, targetTaskId: string | undefined, text: string, userWords?: string,
  callerSessionId?: string, opts: { withdraw?: boolean } = {},
): Promise<PreparedAnswer> {
  if (!targetTaskId) throw new AskAnswerError('bad_request', 'answers_ask needs a task to answer: name it in `to` (or answer its request)', 400);
  const { listTasks, updateTaskRaw } = await import('../task-manager.js');
  const everything = await listTasks();
  // The whole id wins over a prefix (src/lib/id-ref.ts); a prefix only when it names one task.
  const matches = matchIdRef(everything, targetTaskId);
  if (matches.length > 1) throw new AskAnswerError('bad_request', ambiguousIdMessage(targetTaskId, matches), 400);
  const target = matches[0];
  if (!target) throw new AskAnswerError('bad_request', missingIdMessage(targetTaskId), 404);
  const caller = callerTaskId ? everything.find((t) => t.id === callerTaskId) : undefined;
  if (callerTaskId && (!caller || !standsAbove(caller, target, everything))) {
    throw new AskAnswerError('not_above',
      `Not sent: answers_ask answers a task's question to the user in the user's place, which only a task it is under, its lead or VP, or Main does; "${target.title}" (${target.id}) is not below you. `
      + 'Send it without answers_ask, or tell the task that leads it.');
  }
  const open = target.phase === 'COMPLETE' ? finishedAskOf(target) : openAskOf(target);
  if ('none' in open) {
    throw new AskAnswerError('no_open_ask', `Not sent: "${target.title}" (${target.id}) has no ask to answer here: ${open.none}. Or send it without answers_ask.`);
  }
  const { ask, where } = open;
  // An ask of a kind only the user approves (an outward send, spending, credentials...) is answered in
  // their place only on their own words (2026-11-04 review: Main could otherwise approve a spend).
  // With approvals off an outward step is no longer his (approval-kinds.ts, the same list the
  // prompt's approvals-off line reads); spending, credentials and the rest stay his.
  // The kind is the report's: it says what the ask approves only for the report's own ask (or an org
  // node's, from its report); a choice, prompt or letter carries its own checks where it is settled.
  // A prompt over a report that still asks keeps the report's kind (the prompt shows first, user-status.ts).
  const kind = where === 'report' || where === 'chat' || (where === 'prompt' && target.status_report?.state === 'needs')
    ? target.status_report?.ask_own?.kind : undefined;
  const askMe = await asksPerson();
  const words = (userWords ?? '').replace(/\s+/g, ' ').trim();
  // Older reports may label owned code work or an unpublished local draft outward. Correct
  // only the matching plain ask, never a hidden choice, actual send or another approval kind.
  const report = target.status_report;
  const localWork = kind === 'outward' && askKey(report?.ask) === askKey(ask) && !report?.ask_options?.length
    && (!report?.ask_kind || report.ask_kind === 'yes_no' || report.ask_kind === 'text')
    && (isLocalDraftAsk(ask, report?.ask_more) || isTeamCodeAsk(ask, report?.ask_own?.why, report?.ask_more));
  if (caller && kind && !localWork && words.length < 10 && needsUsersWords(kind, askMe)) {
    throw new AskAnswerError('user_words',
      `Not sent: "${target.title}" asks the user to approve a step of kind ${kind}, which only the user decides. `
      + 'Answer it in their place only with their own words: pass user_words quoting what they said (task_history rows with sentBy "person", or their thread message). Otherwise leave it for them.');
  }
  // A withdrawal ("don't remind me again") holds for good, so only the user's own words make one.
  if (opts.withdraw && caller && words.length < 10) {
    throw new AskAnswerError('user_words',
      `Not sent: withdrawing "${target.title}"'s ask for good is the user's call. Pass user_words quoting what they said `
      + '(task_history rows with sentBy "person", or their thread message), or answer it without withdraw_ask.');
  }
  // His words in the task come first: an answer in his place never goes against what he already
  // wrote there unseen (2026-11-07, Main's reflection: "local only" after his "submit the cr").
  const check = caller ? await settleCheck(target, caller.id, userWords, 'sent', everything, { anyAsk: true }) : null;
  if (check?.refusal) throw new AskAnswerError('user_spoke_since', check.refusal);
  const userSaid = check?.said;
  const byTitle = caller ? caller.title : 'The user';
  const answer: AskAnswer = {
    key: askKey(ask), ask, text: text.replace(/\s+/g, ' ').trim().slice(0, 500),
    by: caller ? caller.id : 'human', byTitle, at: new Date().toISOString(),
    ...(caller && words ? { userWords: words.slice(0, 500) } : {}),
    // Only the resolved caller task's own session is recorded; a person's answer has none.
    ...(caller && callerSessionId?.trim() ? { sessionId: callerSessionId.trim() } : {}),
    // The decision it answers, so the same decision asked again in other words stays answered.
    ...decisionOfAsk(target, ask),
    ...(opts.withdraw ? { withdrawn: true as const } : {}),
  };
  const line = opts.withdraw
    ? `${askAnswerLine(ask, byTitle).slice(0, -1)} The user withdrew this ask for good: never put it to them again, in any words, unless they bring it up.]`
    : askAnswerLine(ask, byTitle);
  const settle = await asAnswerError(() => settlerFor({
    where, target, ...('choice' in open && open.choice ? { choice: open.choice } : {}), text, line, withdraw: opts.withdraw === true, byTitle,
    ...(caller ? { callerTaskId: caller.id } : {}), ...(callerSessionId?.trim() ? { callerSessionId: callerSessionId.trim() } : {}),
    ...(userWords ? { userWords } : {}), askMe,
  }));
  return {
    line,
    where,
    ...(settle ? { settle: () => asAnswerError(settle) } : {}),
    target: { id: target.id, title: target.title, phase: target.phase },
    ...(userSaid ? { userSaid } : {}),
    commit: async () => {
      // Kept beside the ones before it, read under the row's lock: one answer never takes another's
      // place, even one recorded while this message was on its way.
      await updateTaskRaw(target.id, (cur) => ({
        ask_answered: answer,
        asks_answered: keptAnswers(cur.asks_answered ?? (cur.ask_answered ? [cur.ask_answered] : []), answer),
      }) as Partial<Task>, { emitEvent: true, source: 'ask-answer' })
        .catch((err) => log.task.warn('ask-answer: not recorded', { taskId: target.id, error: err instanceof Error ? err.message : String(err) }));
      log.task.info('ask-answer: answered for the user', { taskId: target.id, by: answer.by });
    },
  };
}

/** A settle's refusal as answers_ask's own (ask-settle.ts SettleError, its code and status kept). */
async function asAnswerError<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (err) {
    if (err instanceof SettleError) throw new AskAnswerError(err.code, err.message, err.status);
    throw err;
  }
}

/**
 * A teammate whose ask was folded under another task's, which the user (or a lead, VP or Main)
 * answered there, is told once (2026-11-04 review: it sat Waiting with nothing to wake it): which
 * task held it, and the answer when one was recorded. A Walnut note, as the re-check sends it.
 */
export async function tellFoldAnswered(task: Pick<Task, 'id' | 'title'>, fold: SameAskFold): Promise<void> {
  const { listTasks } = await import('../task-manager.js');
  const all = await listTasks();
  const holder = all.find((t) => t.id === fold.id);
  const answer = holder?.ask_answered?.key && holder.ask_answered.key === askKey(fold.ask) ? holder.ask_answered : null;
  const { getSessionsForTask } = await import('../session-tracker.js');
  const { pickDeliverySession } = await import('../routines/session-target.js');
  // Told only while it runs: a stopped session is never resumed for it (answerReach), it reads the
  // fold in its status when it is next started.
  const sessions = (await getSessionsForTask(task.id).catch(() => [])).filter((s) => !s.archived && isLiveSessionStatus(s.process_status));
  const self = all.find((t) => t.id === task.id);
  if (!self || !answerReach(self, sessions).wakes) return;
  const target = pickDeliverySession(sessions);
  if (!target) return;
  const guard = await liveSendGuard(await liveDelivery(target.claudeSessionId));
  const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
  const { sendMessageToSession } = await import('../session-message-queue.js');
  const { WAIT_UNTIL_SEND_SOURCE } = await import('../task-wait-until.js');
  const body = [
    `Your ask of the user ("${fold.ask.replace(/\s+/g, ' ').slice(0, 200)}") was the same as the one of "${fold.title}" (${fold.id}), beside you in your team, and it was answered there.`,
    answer ? `${answer.byTitle} answered it for the user: "${answer.text.replace(/\s+/g, ' ').slice(0, 400)}".` : 'The user answered it in that task: read its answer there (task_history, or task_send it).',
    'Carry on with that answer, and do not ask the user again.',
  ].join('\n');
  try {
    await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
      kind: 'notification', attrs: { from: 'Walnut', note: 'your ask was answered in a teammate' }, body,
    }), { source: WAIT_UNTIL_SEND_SOURCE, taskId: task.id, ...guard });
  } catch (err) {
    // Stopped meanwhile: it reads the fold in its status when it is next started.
    if (await notDeliveredLive(err)) return;
    throw err;
  }
  log.task.info('same-ask: a teammate told its folded ask was answered', { taskId: task.id, holder: fold.id });
}
