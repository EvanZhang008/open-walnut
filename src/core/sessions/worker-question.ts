/**
 * A worker's AskUserQuestion goes to its leader, not to the user.
 *
 * A worker is a task with a parent (its leader) whose session it can message.
 * When the worker's CLI asks to run AskUserQuestion, the question would pop up
 * for the user and park the worker until they find it. In a team the leader is
 * the one who talks to the user, so Walnut sends the question to the leader as
 * an ordinary task_send from the worker (expect_reply on, so the answer comes
 * back as a reply) and answers the CLI's permission request with a deny whose
 * message says where the question went. 2026-10-05: a worker asked the user
 * "which of these three should I do?" right after its leader relayed the user's
 * go; the user found the prompt an hour later ("why am I asked again? what are
 * you for?"), and the leader's two follow-ups waited behind it.
 *
 * Not routed (the user answers, as before): a task with no parent, a parent that
 * is COMPLETE or has no session, or a send Walnut refuses (throttled, archived).
 * One route per CLI request id: a daemon replay of the same control_request (a
 * reconnect) answers with the first result instead of asking the leader twice.
 */

import { log } from '../../logging/index.js';

export interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
}

export interface RoutedQuestion {
  /** The deny message the worker's CLI shows the model in place of an answer. */
  message: string;
  requestId?: string;
  leaderTaskId: string;
}

const clean = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** The question as the leader reads it, plus a one-line title. Pure. */
export function formatWorkerQuestion(input: AskUserQuestionInput | undefined): { title: string; text: string } | null {
  const questions = (input?.questions ?? []).filter((q) => clean(q?.question));
  if (questions.length === 0) return null;
  const blocks = questions.map((q, i) => {
    const head = [
      questions.length > 1 ? `Question ${i + 1} of ${questions.length}` : 'Question',
      clean(q.header) ? ` (${clean(q.header)})` : '',
      q.multiSelect ? ', pick any number' : '',
      ': ',
      clean(q.question),
    ].join('');
    const options = (q.options ?? [])
      .filter((o) => clean(o?.label))
      .map((o) => `  - ${clean(o.label)}${clean(o.description) ? `: ${clean(o.description)}` : ''}`);
    return [head, ...options].join('\n');
  });
  const first = questions[0];
  return {
    title: `Question: ${clean(first.header) ? `${clean(first.header)}: ` : ''}${clean(first.question)}`,
    text: [
      'I was about to ask the user this; in our team my questions come to you.',
      ...blocks,
      'Answer with the reply command below. If only the user can decide, ask them in your own session and pass their answer on.',
    ].join('\n\n'),
  };
}

const routed = new Map<string, Promise<RoutedQuestion | null>>();
const ROUTED_MAX = 500;

/** Test seam. */
export function _clearRoutedQuestions(): void {
  routed.clear();
}

async function route(sessionId: string, taskId: string, input: AskUserQuestionInput | undefined): Promise<RoutedQuestion | null> {
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => undefined);
  if (!task?.parent_task_id) return null;
  const leader = await getTask(task.parent_task_id).catch(() => undefined);
  if (!leader || leader.phase === 'COMPLETE') return null;
  const question = formatWorkerQuestion(input);
  if (!question) return null;
  const { performSessionSend } = await import('./session-send-core.js');
  try {
    const sent = await performSessionSend({
      callerSid: sessionId, to: leader.id, text: question.text, title: question.title, expectReply: true,
    });
    log.session.info('worker question sent to its leader', {
      sessionId, taskId, leaderTaskId: leader.id, requestId: sent.requestId, delivery: sent.delivery,
    });
    return {
      requestId: sent.requestId,
      leaderTaskId: leader.id,
      message: `In this team your questions go to your leader, "${leader.title}" (task ${leader.id}), not to the user. `
        + `Your question was sent to it${sent.requestId ? ` as request ${sent.requestId}` : ''}, and its answer `
        + 'arrives in this session as a reply. Do not ask the user. Carry on with what does not depend on the '
        + 'answer, or end your turn.',
    };
  } catch (err) {
    // No leader session, throttled, archived: the user answers, as before.
    log.session.info('worker question stays with the user', {
      sessionId, taskId, leaderTaskId: leader.id,
      reason: (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err)),
    });
    return null;
  }
}

/**
 * Send a worker's AskUserQuestion to its leader. Null when it is not a worker's
 * question to route; the caller then shows it to the user. Never throws.
 */
export function routeWorkerQuestion(args: {
  sessionId: string;
  taskId: string;
  requestId: string;
  input: AskUserQuestionInput | undefined;
}): Promise<RoutedQuestion | null> {
  const key = `${args.sessionId}:${args.requestId}`;
  const known = routed.get(key);
  if (known) return known;
  const result = route(args.sessionId, args.taskId, args.input).catch((err) => {
    log.session.warn('worker question routing failed; asking the user', {
      sessionId: args.sessionId, taskId: args.taskId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  routed.set(key, result);
  if (routed.size > ROUTED_MAX) routed.delete(routed.keys().next().value!);
  return result;
}
