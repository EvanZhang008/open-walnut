/**
 * His words sent into a thread that holds a live decision letter answer that letter (2026-11-20,
 * the user typed "K" in the box of a card asking "release the new Mac app?" with two buttons; it
 * went to the node's chat as a follow-up filed under the thread, the letter stayed unanswered and
 * the card stayed as it was, looking unsent: "what the fuck?").
 *
 * Whatever box he typed in (a thread card's, an older client's Follow up, the phone's), a send that
 * names such a thread goes through the letter's own words answer (letter-ops.ts
 * humanReplyAndDeliver, the rule awaitsUserDecision reads): the letter reads answered with his
 * words as its note, the thread settles with it (human-inbox/letter-threads.ts), and the asking
 * session gets his words once, as the letter's answer, never also as a chat message. A letter
 * that no longer waits (answered a moment ago, withdrawn) leaves the send as it was: a follow-up.
 */
import { log } from '../../logging/index.js';
import { holdsLetter } from './letter-thread-model.js';

export interface LetterFollowUp { letterId: string; threadId: string }

/** Answer the live letter `threadId` holds on `taskId`'s Threads with his words; null when it holds none. Never throws. */
export async function answerLetterOnThread(input: {
  taskId: string;
  threadId: string;
  text: string;
  /** Pictures already saved with the send. */
  images?: string[];
  /** The send's own id: a retry of it answers once. */
  clientId?: string;
}): Promise<LetterFollowUp | null> {
  if (!input.text.trim() && !input.images?.length) return null;
  try {
    const { readThreads } = await import('./threads-store.js');
    const t = (await readThreads(input.taskId)).threads.find((x) => x.id === input.threadId);
    if (!t?.letter || !holdsLetter(t)) return null;
    const { humanReplyAndDeliver } = await import('../human-inbox/letter-ops.js');
    await humanReplyAndDeliver(t.letter.id, {
      text: input.text,
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
    });
    log.notif.info('letter threads: his follow-up answered the letter its thread holds', { taskId: input.taskId, threadId: t.id, letterId: t.letter.id });
    return { letterId: t.letter.id, threadId: t.id };
  } catch (err) {
    // Answered or gone a moment ago: the send goes on as a follow-up.
    log.notif.info('letter threads: a follow-up on a letter thread stays a follow-up', { taskId: input.taskId, threadId: input.threadId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
