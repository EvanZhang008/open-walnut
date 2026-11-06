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
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { briefTeam } from '../user-status.js';
import { APPROVAL_KINDS, ASKS_ANSWERED_MAX, askAnswerLine, askKey, type AskAnswer, type SameAskFold } from '../same-ask.js';

export class AskAnswerError extends Error {
  constructor(readonly code: 'not_above' | 'no_open_ask' | 'user_words' | 'bad_request', message: string, readonly status = 409) {
    super(message);
    this.name = 'AskAnswerError';
  }
}

/**
 * The session's own question to the user this task shows now, or why there is none to answer here:
 * a Board choice is answered on the Board, and an ask shown on another task (a fold) is answered
 * there, where the user sees it.
 */
export function openAskOf(t: Pick<Task, 'user_status' | 'status_report'>): { ask: string } | { none: string } {
  const us = t.user_status;
  if (us?.state === 'needs' && us.ask && us.source === 'session') return { ask: us.ask };
  if (us?.state === 'needs' && us.source === 'choice') return { none: 'its ask is a Board choice: answer it on the Board (board_post / the choice)' };
  if (us?.sameAsk) return { none: `its ask shows on "${us.sameAsk.title}" (${us.sameAsk.id}), which asks the user the same: answer that task` };
  const r = t.status_report;
  if (r?.state === 'needs' && r.ask && (us?.snoozed?.ask || us?.answeredFor || us?.transient || us?.state === 'working')) return { ask: r.ask };
  return { none: 'it asks the user nothing now' };
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

export interface PreparedAnswer {
  /** Walnut's line that leads the answer: the one time the asker is told. */
  line: string;
  /** Record it on the asker once the message is queued. */
  commit: () => Promise<void>;
}

/**
 * Check an `answers_ask` send and shape its text. `callerTaskId` null = a person (their own answer).
 * `targetTaskId` is the task the message goes to (with in_reply_to, the request's asker).
 */
export async function prepareAskAnswer(
  callerTaskId: string | null, targetTaskId: string | undefined, text: string, userWords?: string,
): Promise<PreparedAnswer> {
  if (!targetTaskId) throw new AskAnswerError('bad_request', 'answers_ask needs a task to answer: name it in `to` (or answer its request)', 400);
  const { listTasks, updateTaskRaw } = await import('../task-manager.js');
  const everything = await listTasks();
  const target = everything.find((t) => t.id === targetTaskId || t.id.startsWith(targetTaskId));
  if (!target) throw new AskAnswerError('bad_request', `No task ${targetTaskId}`, 404);
  const caller = callerTaskId ? everything.find((t) => t.id === callerTaskId) : undefined;
  if (callerTaskId && (!caller || !standsAbove(caller, target, everything))) {
    throw new AskAnswerError('not_above',
      `Not sent: answers_ask answers a task's question to the user in the user's place, which only a task it is under, its lead or VP, or Main does; "${target.title}" (${target.id}) is not below you. `
      + 'Send it without answers_ask, or tell the task that leads it.');
  }
  const open = openAskOf(target);
  if ('none' in open) {
    throw new AskAnswerError('no_open_ask', `Not sent: "${target.title}" (${target.id}) has no ask to answer here: ${open.none}. Or send it without answers_ask.`);
  }
  const { ask } = open;
  // An ask of a kind only the user approves (an outward send, spending, credentials...) is answered in
  // their place only on their own words (2026-11-04 review: Main could otherwise approve a spend).
  const kind = target.status_report?.ask_own?.kind;
  const words = (userWords ?? '').replace(/\s+/g, ' ').trim();
  if (caller && kind && APPROVAL_KINDS.has(kind) && words.length < 10) {
    throw new AskAnswerError('user_words',
      `Not sent: "${target.title}" asks the user to approve a step of kind ${kind}, which only the user decides. `
      + 'Answer it in their place only with their own words: pass user_words quoting what they said (task_history rows with sentBy "person", or their thread message). Otherwise leave it for them.');
  }
  const byTitle = caller ? caller.title : 'The user';
  const answer: AskAnswer = {
    key: askKey(ask), ask, text: text.replace(/\s+/g, ' ').trim().slice(0, 500),
    by: caller ? caller.id : 'human', byTitle, at: new Date().toISOString(),
    ...(caller && words ? { userWords: words.slice(0, 500) } : {}),
  };
  return {
    line: askAnswerLine(ask, byTitle),
    commit: async () => {
      // Kept beside the ones before it, read under the row's lock: one answer never takes another's
      // place, even one recorded while this message was on its way.
      await updateTaskRaw(target.id, (cur) => ({
        ask_answered: answer,
        asks_answered: [...(cur.asks_answered ?? (cur.ask_answered ? [cur.ask_answered] : [])).filter((a) => a.key !== answer.key), answer].slice(-ASKS_ANSWERED_MAX),
      }) as Partial<Task>, { emitEvent: true, source: 'ask-answer' })
        .catch((err) => log.task.warn('ask-answer: not recorded', { taskId: target.id, error: err instanceof Error ? err.message : String(err) }));
      log.task.info('ask-answer: answered for the user', { taskId: target.id, by: answer.by });
    },
  };
}

/**
 * A teammate whose ask was folded under another task's, which the user (or a lead, VP or Main)
 * answered there, is told once (2026-11-04 review: it sat Waiting with nothing to wake it): which
 * task held it, and the answer when one was recorded. A Walnut note, as the re-check sends it.
 */
export async function tellFoldAnswered(task: Pick<Task, 'id' | 'title'>, fold: SameAskFold): Promise<void> {
  const { listTasks } = await import('../task-manager.js');
  const holder = (await listTasks()).find((t) => t.id === fold.id);
  const answer = holder?.ask_answered?.key && holder.ask_answered.key === askKey(fold.ask) ? holder.ask_answered : null;
  const { getSessionsForTask } = await import('../session-tracker.js');
  const { pickDeliverySession } = await import('../routines/session-target.js');
  const target = pickDeliverySession(await getSessionsForTask(task.id).catch(() => []));
  if (!target) return;
  const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
  const { sendMessageToSession } = await import('../session-message-queue.js');
  const { WAIT_UNTIL_SEND_SOURCE } = await import('../task-wait-until.js');
  const body = [
    `Your ask of the user ("${fold.ask.replace(/\s+/g, ' ').slice(0, 200)}") was the same as the one of "${fold.title}" (${fold.id}), beside you in your team, and it was answered there.`,
    answer ? `${answer.byTitle} answered it for the user: "${answer.text.replace(/\s+/g, ' ').slice(0, 400)}".` : 'The user answered it in that task: read its answer there (task_history, or task_send it).',
    'Carry on with that answer, and do not ask the user again.',
  ].join('\n');
  await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
    kind: 'notification', attrs: { from: 'Walnut', note: 'your ask was answered in a teammate' }, body,
  }), { source: WAIT_UNTIL_SEND_SOURCE, taskId: task.id });
  log.task.info('same-ask: a teammate told its folded ask was answered', { taskId: task.id, holder: fold.id });
}
