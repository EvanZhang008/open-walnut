/**
 * A Follow up's thread, said before its words go out (2026-11-10, the user: "ios 和web回复thread都要
 * thread自动消失 至少ios没有这样"). The phone sends a Follow up through the companion, whose relay to
 * the Mac (`session.message`, through the host's daemon) carries the words alone, so the Mac filed
 * them by its own guess and the thread he answered stayed `answered`, on his view. The phone now
 * tells the Mac first, through a thread write the companion forwards (`PUT /tasks/:id/threads/
 * :thread/follow-ups/:messageId`), and the relayed message with that id is filed under the thread
 * as the primary box's own send route files it.
 *
 * Kept in memory for an hour: a relay arrives seconds later, and a send the companion holds while
 * the Mac is away could not have told it either (that send is filed by Walnut's pick, as before).
 */

const KEEP_MS = 60 * 60_000;
/** A bound, so a client that never sends what it announced cannot grow this without end. */
const MAX_INTENTS = 2000;

interface Intent { taskId: string; threadId: string; at: number }

const intents = new Map<string, Intent>();

function sweep(now: number): void {
  for (const [id, it] of intents) {
    if (now - it.at <= KEEP_MS && intents.size <= MAX_INTENTS) break;
    intents.delete(id);
  }
}

/** The message `messageId` the person is about to send into `taskId`'s chat belongs to `threadId`. */
export function noteFollowUpIntent(taskId: string, threadId: string, messageId: string, now = Date.now()): void {
  intents.delete(messageId);
  intents.set(messageId, { taskId, threadId, at: now });
  sweep(now);
}

/**
 * The thread a relayed message was announced for, when it was for this node. Not taken: a retry of
 * the same id is filed under the same thread (the capture's own key dedupes it).
 */
export function followUpIntentFor(taskId: string | undefined, messageId: string, now = Date.now()): string | undefined {
  if (!taskId) return undefined;
  const it = intents.get(messageId);
  if (!it || now - it.at > KEEP_MS || it.taskId !== taskId) return undefined;
  return it.threadId;
}

/** Tests only. */
export function _resetFollowUpIntents(): void {
  intents.clear();
}
