/**
 * His words sent into a thread that holds a live Board choice answer that choice (experiment
 * brief_off; the same class as a decision letter's thread, org/letter-follow-up.ts). Whatever box
 * he typed in (a thread card's, an older client's Follow up, the phone's), a send that names such
 * a thread goes through the Board's own choice answer (board-choice-answer.ts), as the user: the
 * Board records it, its task hears it once as the choice's answer, never also as a chat message,
 * and the thread settles with it (choice-threads.ts).
 *
 * The same guards as the letter's words (human-inbox/answer-approval.ts wordsAnswer, his own words
 * on the card, so read as verified): a bare yes ("K", "ok") picks the option the choice recommends
 * and no other (none recommended: it stays a follow-up), short words pick the one option they
 * name, other words of at least USER_WORDS_MIN characters answer as his note with no option. Only
 * a person answers (a browser under automation keeps a follow-up), only on the leader (the Board
 * is there), and a send with pictures stays a follow-up, which carries them. A resend of the same
 * words is the same answer (the Board keeps one per choice; an unchanged one is not delivered
 * again).
 */
import { log } from '../../logging/index.js';
import { isBareYes, wordsAnswer } from '../human-inbox/answer-approval.js';
import type { ThreadChoice } from '../org/choice-thread-model.js';

export interface ChoiceFollowUp { board: string; choiceId: string; threadId: string; option?: string }

/** What his words answer on this choice: an option, his note, or null (they stay a follow-up). Pure. */
export function choiceWordsPick(text: string, choice: Pick<ThreadChoice, 'options' | 'recommended'>): { option: string } | { text: string } | null {
  const words = text.trim();
  if (!words) return null;
  const picks = choice.options.filter((o) => wordsAnswer(words, { label: o.label || o.value, recommended: o.value === choice.recommended }, true).picks
    || (!isBareYes(words) && words.toLowerCase() === o.value.toLowerCase()));
  if (picks.length === 1) return { option: picks[0]!.value };
  if (picks.length > 1 || isBareYes(words)) return null;
  return wordsAnswer(words, undefined, true).ok ? { text: words } : null;
}

/**
 * Answer the live choice `threadId` holds on `taskId`'s Threads with his words; null when the
 * send stays a follow-up. Never throws.
 */
export async function answerChoiceOnThread(input: {
  taskId: string;
  threadId: string;
  text: string;
  images?: string[];
  confirmOnly?: boolean;
}): Promise<ChoiceFollowUp | null> {
  if (input.confirmOnly || input.images?.length || !input.text.trim()) return null;
  try {
    const { briefOffOn } = await import('../org/brief-off.js');
    if (!(await briefOffOn())) return null;
    const { ambientAutomatedClient } = await import('../sessions/automated-client.js');
    if (ambientAutomatedClient()) return null;
    const { isFollower } = await import('../server-role.js');
    if (isFollower()) return null;
    const { threadHolder } = await import('../org/threads-store.js');
    const { holdsChoice } = await import('../org/choice-thread-model.js');
    const t = (await threadHolder(input.taskId, input.threadId))?.thread;
    if (!t?.choice || !holdsChoice(t)) return null;
    const pick = choiceWordsPick(input.text, t.choice);
    if (!pick) return null;
    const { answerBoardChoice } = await import('./board-choice-answer.js');
    await answerBoardChoice(t.choice.board, t.choice.id, pick, { kind: 'human' });
    const option = 'option' in pick ? pick.option : undefined;
    log.task.info('choice threads: his words answered the choice their thread holds', {
      taskId: input.taskId, threadId: t.id, board: t.choice.board, choice: t.choice.id, picked: !!option,
    });
    return { board: t.choice.board, choiceId: t.choice.id, threadId: t.id, ...(option ? { option } : {}) };
  } catch (err) {
    // Answered or gone a moment ago: the send goes on as a follow-up.
    log.task.info('choice threads: a send on a choice thread stays a follow-up', { taskId: input.taskId, threadId: input.threadId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
