/**
 * An answer in the user's place (task_send answers_ask, ask-answer.ts) settled where the ask lives,
 * for every ask his Needs you shows that is not the session's own report (2026-11-13, Main: "凡是
 * Brief 列在 Needs you 里的问话，上级都能用同一个 answers_ask 答掉或撤掉"):
 *  - a Board choice: answered on its Board, and its Board's task told (boards/board-choice-answer.ts);
 *  - a prompt open in the session: an AskUserQuestion answered with the words (a step only the user
 *    approves, named in the question or the answer, still needs his words); any other tool's prompt
 *    denied, the answer as its message (allowing a tool stays the person's: a permission);
 *  - a decision letter: answered in the inbox by one of its options, named in the answer (a decision
 *    letter always has them; the letter's own checks: the user's words name what they approve);
 *    settled on a withdrawal.
 * `tell`: the task hears it only from our message (a settled letter, a denial an ACP engine drops).
 * A report or chat ask has no settler: the answer goes to the task as a message (session-send-core.ts).
 */
import type { Task } from '../types.js';
import type { AskWhere } from './ask-answer.js';

export type SettledVia = (
  | { via: 'board_choice'; board: string; choice: string; delivery: string }
  | { via: 'question'; sessionId: string }
  | { via: 'prompt_denied'; sessionId: string; tool: string }
  | { via: 'letter'; letterId: string; settled?: true }
) & { tell?: true };

/** The asks answers_ask settles outside the task's report (the ratchet reads this list). */
export const SETTLED_WHERE: ReadonlySet<AskWhere> = new Set<AskWhere>(['choice', 'prompt', 'letter']);

export interface SettleInput {
  where: AskWhere;
  target: Pick<Task, 'id' | 'title'>;
  choice?: { board: string; id: string };
  /** The answer's words, and Walnut's line telling the asker who answered. */
  text: string;
  line: string;
  withdraw: boolean;
  byTitle: string;
  callerTaskId?: string;
  callerSessionId?: string;
  userWords?: string;
  /** The Approvals switch: with it off an outward step is no longer the user's (approval-kinds.ts). */
  askMe: boolean;
}

/** A settle that cannot run: why, as answers_ask refuses it. */
export class SettleError extends Error {
  constructor(readonly code: 'no_open_ask' | 'user_words' | 'human_approval' | 'not_confirmed', message: string, readonly status = 409) {
    super(message);
    this.name = 'SettleError';
  }
}

/** How to settle the ask where it lives, checked now (so a refusal comes before anything is sent); none for a report or chat ask. */
export async function settlerFor(input: SettleInput): Promise<(() => Promise<SettledVia>) | undefined> {
  if (input.where === 'choice') return choiceSettler(input);
  if (input.where === 'prompt') return promptSettler(input);
  if (input.where === 'letter') return letterSettler(input);
  return undefined;
}

const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();

/** The option an answer's words name (its value or its label, case-blind), if any: a Board choice's or a letter's. */
export function optionNamedBy(text: string, options: ReadonlyArray<{ value: string; label: string }>): string | undefined {
  const t = oneLine(text).toLowerCase();
  return options.find((o) => o.value.toLowerCase() === t || oneLine(o.label).toLowerCase() === t)?.value;
}

async function choiceSettler(input: SettleInput): Promise<() => Promise<SettledVia>> {
  const ref = input.choice;
  if (!ref) throw new SettleError('no_open_ask', `Not sent: "${input.target.title}" shows a Board choice that names no Board.`);
  const { getBoard } = await import('../boards/board-store.js');
  const { choiceSpecs } = await import('../boards/board-html.js');
  const board = await getBoard(ref.board).catch(() => null);
  const spec = board?.html ? choiceSpecs(board.html)[ref.id] : undefined;
  if (!spec || board?.choices?.[ref.id]) {
    throw new SettleError('no_open_ask', `Not sent: the Board choice "${ref.id}" on ${ref.board} is no longer open (answered, or gone from its Board).`);
  }
  const { answerBoardChoice } = await import('../boards/board-choice-answer.js');
  const words = oneLine(input.text);
  const option = input.withdraw ? undefined : optionNamedBy(words, spec.options);
  const answer = input.withdraw ? { text: `Withdrawn by ${input.byTitle} for the user: ${words}` }
    : option ? { option } : { text: `${input.byTitle} answered for the user: ${words}` };
  const caller = input.callerTaskId && input.callerSessionId
    ? { kind: 'task' as const, taskId: input.callerTaskId, sessionId: input.callerSessionId }
    : { kind: 'human' as const };
  return async () => {
    const { delivery } = await answerBoardChoice(ref.board, ref.id, answer, caller);
    return { via: 'board_choice', board: ref.board, choice: ref.id, delivery: delivery.state };
  };
}

/** The approval kind of each risky step the letters' check names (human-inbox/answer-approval.ts). */
const STEP_KIND: Record<string, string> = { outward: 'outward', spend: 'spending', access: 'credentials', delete: 'cloud_delete', history: 'irreversible', unpublish: 'irreversible' };

async function promptSettler(input: SettleInput): Promise<() => Promise<SettledVia>> {
  const { getSessionsForTask } = await import('../session-tracker.js');
  const open = (await getSessionsForTask(input.target.id).catch(() => []))
    .filter((s) => !s.archived && s.pendingPermission?.requestId)
    .sort((a, b) => (b.pendingPermission!.receivedAt ?? '').localeCompare(a.pendingPermission!.receivedAt ?? ''))[0];
  if (!open) throw new SettleError('no_open_ask', `Not sent: "${input.target.title}" has no prompt open now (it was answered meanwhile).`);
  const pending = open.pendingPermission!;
  const tool = pending.toolName ?? 'unknown';
  const sid = open.claudeSessionId;
  const words = oneLine(input.text);
  const questions = Array.isArray((pending.input as { questions?: unknown } | undefined)?.questions)
    ? ((pending.input as { questions: Array<{ question?: unknown }> }).questions).map((q) => q.question).filter((q): q is string => typeof q === 'string' && !!q)
    : [];
  const answerQuestion = tool === 'AskUserQuestion' && !input.withdraw && questions.length > 0;
  if (answerQuestion) {
    // As a letter's answer is checked (answer-approval.ts): a step only the user approves, asked
    // in the question or approved by the answer, needs his words naming it.
    const { stepsIn } = await import('../human-inbox/answer-approval.js');
    const { needsUsersWords } = await import('../approval-kinds.js');
    const named = new Set(stepsIn(input.userWords ?? '').map((s) => s.id));
    const unnamed = stepsIn(`${questions.join('\n')}\n${words}`)
      .filter((s) => !named.has(s.id) && needsUsersWords(STEP_KIND[s.id], input.askMe));
    if (unnamed.length) {
      throw new SettleError('user_words', `Not sent: the question "${oneLine(questions[0]!).slice(0, 160)}" asks about ${unnamed.map((s) => s.label).join('; ')}, which only the user approves. `
        + 'Pass user_words quoting what they said about that step (task_history rows with sentBy "person", or their thread message), or leave it for them.');
    }
  }
  const { isAcpEngine } = await import('../agents/engine-registry.js');
  // An ACP engine's prompt takes no reason: the denial's words reach it as our message instead.
  const tellDenial = isAcpEngine(open.engine);
  return async () => {
    const { respondSessionPermission } = await import('./session-lifecycle.js');
    const { SessionControlError } = await import('./session-controls.js');
    try {
      if (answerQuestion) {
        await respondSessionPermission(sid, pending.requestId, true, undefined, undefined,
          Object.fromEntries(questions.map((q) => [q, `${words} (answered by ${input.byTitle} for the user)`])));
        return { via: 'question', sessionId: sid };
      }
      await respondSessionPermission(sid, pending.requestId, false, `${input.line} ${words}`.trim());
      return { via: 'prompt_denied', sessionId: sid, tool, ...(tellDenial ? { tell: true as const } : {}) };
    } catch (err) {
      if (err instanceof SessionControlError && err.statusCode === 404) {
        throw new SettleError('no_open_ask', `Not settled: the ${tool} prompt of "${input.target.title}" could not be answered (${err.message}). If its session stopped, task_restart it; the prompt is asked again there.`);
      }
      if (err instanceof SessionControlError) {
        throw new SettleError('not_confirmed', `Not settled yet: the ${tool} prompt of "${input.target.title}" did not confirm the answer (${err.message}). Send the same answer again.`, err.statusCode >= 500 ? 503 : err.statusCode);
      }
      throw err;
    }
  };
}

async function letterSettler(input: SettleInput): Promise<() => Promise<SettledVia>> {
  const { listLetters, settleLetter, LetterError } = await import('../human-inbox/store.js');
  const { letters } = await listLetters({ archived: false });
  const letter = letters
    .filter((l) => l.type === 'action_required' && !l.answered && !l.archived && l.sender?.taskId === input.target.id)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!letter) throw new SettleError('no_open_ask', `Not sent: "${input.target.title}" has no open decision letter now (it was answered or settled).`);
  const { answeredByCaller, answerLetterAndDeliver, withUserWords } = await import('../human-inbox/letter-ops.js');
  const by = withUserWords(await answeredByCaller(input.callerSessionId), { user_words: input.userWords ?? '' });
  const words = oneLine(input.text);
  const actions = letter.actions ?? [];
  const action = optionNamedBy(words, actions.map((a) => ({ value: a.id, label: a.label })));
  // Answered by one of its options, so it leaves the inbox; a reply alone would not.
  if (!input.withdraw && !action) {
    throw new SettleError('no_open_ask', `Not sent: the letter "${letter.subject}" is answered by one of its options; name one exactly in your text: ${actions.map((a) => `"${a.label}"`).join(', ')}.`);
  }
  return async () => {
    try {
      if (input.withdraw) {
        await settleLetter(letter.id, { reason: `Withdrawn by ${input.byTitle} for the user: ${words}`, ...(by ? { by } : {}) });
        return { via: 'letter', letterId: letter.id, settled: true, tell: true };
      }
      await answerLetterAndDeliver(letter.id, { actionId: action!, ...(by ? { by } : {}) });
      return { via: 'letter', letterId: letter.id };
    } catch (err) {
      // The letter's own checks: the user's words must name what the answer approves (answer-approval.ts).
      if (err instanceof LetterError && (err.code === 'user_words' || err.code === 'human_approval')) throw new SettleError(err.code, `Not sent: ${err.message}`, err.code === 'user_words' ? 409 : err.status);
      if (err instanceof LetterError && err.code === 'already_answered') throw new SettleError('no_open_ask', `Not sent: the letter "${letter.subject}" was answered meanwhile.`);
      throw err;
    }
  };
}
