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
 * session gets his words once, as the letter's answer, never also as a chat message.
 *
 * The rules around it (each a review finding of 2026-11-20):
 *  - Only a person answers: a browser under automation (sessions/automated-client.ts) never does;
 *    its send stays a follow-up, framed as an agent's by prepareHintedSend.
 *  - Once per send: the send's own id (the web's user uuid, the phone's qm- id) is the letter
 *    turn's clientId, so a retry, a resend after a lost receipt or the phone's resend of the same
 *    id returns the turn already on record, delivered once (a failed one is delivered again).
 *  - The letter is checked again under its own lock (store.ts humanReplyTurn whileWaiting): one
 *    answered meanwhile (a tap in the inbox) leaves his words a plain follow-up on the thread.
 *  - A failed delivery is returned, so the box keeps his words and says so.
 *  - On a replica the letter is the leader's: the turn goes there, as the inbox route's does.
 */
import { log } from '../../logging/index.js';
import { holdsLetter } from './letter-thread-model.js';
import type { LetterDelivery } from '../human-inbox/letter-ops.js';

export interface LetterFollowUp { letterId: string; threadId: string; delivery: LetterDelivery }

/** How long a send waits for the delivery before it answers "on its way" (the inbox route's budget). */
export const LETTER_ANSWER_WAIT_MS = 10_000;

/**
 * Answer the live letter `threadId` holds on `taskId`'s Threads with his words; null when the send
 * stays a follow-up (no letter, answered meanwhile, an automated client). `confirmOnly`: only find
 * the send already on record by its id (a lost receipt), never record a new turn. Never throws.
 */
export async function answerLetterOnThread(input: {
  taskId: string;
  threadId: string;
  text: string;
  /** Pictures already saved with the send. */
  images?: string[];
  /** The send's own id: a retry of it answers once. */
  clientId?: string;
  confirmOnly?: boolean;
}): Promise<LetterFollowUp | null> {
  if (!input.text.trim() && !input.images?.length && !input.confirmOnly) return null;
  try {
    // Only with threads_one_card on (one-card.ts): off, his words on the thread are a follow-up, as before.
    const { oneCardOn } = await import('./one-card.js');
    if (!(await oneCardOn())) return null;
    const { ambientAutomatedClient } = await import('../sessions/automated-client.js');
    if (ambientAutomatedClient()) return null;
    const { threadHolder } = await import('./threads-store.js');
    const t = (await threadHolder(input.taskId, input.threadId))?.thread;
    if (!t?.letter || t.letter.off) return null;
    // A thread still waiting answers; any other names its turn by the send's id or stays a follow-up.
    const fresh = holdsLetter(t) && !input.confirmOnly;
    if (!fresh && !input.clientId) return null;
    const turn = {
      text: input.text,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(fresh ? { whileWaiting: true as const } : { repeatOnly: true as const }),
    };
    const { isFollower } = await import('../server-role.js');
    const delivery = isFollower()
      ? await viaLeader(t.letter.id, turn, !!input.images?.length)
      : (await (await import('../human-inbox/letter-ops.js')).humanReplyAndDeliver(t.letter.id, {
        ...turn, ...(input.images?.length ? { images: input.images } : {}),
      }, { answerBy: Date.now() + LETTER_ANSWER_WAIT_MS })).delivery;
    if (!delivery) return null;
    log.notif.info('letter threads: his words answered the letter their thread holds', {
      taskId: input.taskId, threadId: t.id, letterId: t.letter.id, status: delivery.status, repeat: !fresh,
    });
    return { letterId: t.letter.id, threadId: t.id, delivery };
  } catch (err) {
    // Answered or gone a moment ago, or not a send on record: the send goes on as a follow-up.
    log.notif.info('letter threads: a send on a letter thread stays a follow-up', { taskId: input.taskId, threadId: input.threadId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The turn on the leader, where the letter lives (human-inbox/relay.ts human-reply). Null: it stays a follow-up. */
async function viaLeader(
  letterId: string,
  turn: { text: string; clientId?: string; whileWaiting?: true; repeatOnly?: true },
  pictures: boolean,
): Promise<LetterDelivery | null> {
  // A replica's pictures are on the replica: such a send stays a follow-up, which carries them.
  if (pictures) return null;
  const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js');
  const out = await callPrimaryControl('server.human-inbox.human-reply', '__server__', { id: letterId, ...turn }, LETTER_ANSWER_WAIT_MS);
  if (!out.ok) {
    log.notif.info('letter threads: the leader did not take his words as the letter answer', { letterId, kind: out.failure.kind });
    return null;
  }
  const d = out.result.delivery as LetterDelivery | undefined;
  return d && typeof d.status === 'string' ? d : { status: 'pending' };
}
