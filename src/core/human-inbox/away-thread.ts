/**
 * One thread per absence: the letters Main or a lead sends while the user is away from its chat.
 *
 * 2026-10-31, the user before going to sleep: important updates go to his inbox while he is not in
 * the chat, and use the inbox's thread rather than many letters. So, from an org node the user is
 * away from (org/user-away.ts):
 *  - its first letter of the absence is sent as usual and marked (`awayThread`);
 *  - a later update (info, review, completion) joins that letter's thread as a turn, never a new letter;
 *  - a decision (action_required) stays its own letter, because its options are what one tap answers,
 *    and nothing of it goes into the thread: a letter's thread holds only that letter's own news, never
 *    a line pointing at another letter (2026-11-03: three "needs your answer, in its own letter" lines
 *    about unrelated decisions sat in the thread of the absence's first letter, about a deadline);
 *  - the phone buzzes once: nothing of the absence pushes while a letter of it is still unread, or
 *    after one of the node's threads buzzed moving into needs this absence (push/thread-push.ts). Once
 *    he has read it, the next turn buzzes again; a decision buzzes when the unread letter that did is
 *    older than DECISION_QUIET_MS, so a night's first letter never silences a morning decision.
 * The absence is "since he was last in the chat": a letter of it was made after that moment (so a
 * restart that forgets a heartbeat keeps the thread). A thread is used for AWAY_THREAD_MAX_MS, and only
 * by the session that wrote it (his answers in it go to that session). Pinned, mail items and a letter
 * the user asked for stand alone, as before. A letter about one of the node's open Threads never gets
 * here: it is refused before (thread-instead.ts; 2026-11-04, the user: one place per update).
 */
import type { AwayThreadMark, LetterRecord, LetterSender, NewLetter } from './types.js';

export const AWAY_THREAD_MAX_MS = 24 * 60 * 60_000;
export const DECISION_QUIET_MS = 3 * 60 * 60_000;

type SendInput = Omit<NewLetter, 'sender'>;

export type AwayPlan =
  | { kind: 'fold'; into: LetterRecord }
  | { kind: 'new'; mark: AwayThreadMark; quiet: boolean };

/** Pure: how a letter from an away node goes out, given that node's open away letters. */
export function planAwaySend(
  input: Pick<SendInput, 'type' | 'pin' | 'items' | 'userAsked' | 'user_asked'>,
  mark: AwayThreadMark,
  sessionId: string,
  letters: readonly LetterRecord[],
  now: number,
  /** The latest buzz of one of the node's threads moving into needs this absence (push/thread-push.ts), or null. */
  threadBuzzAt: number | null = null,
): AwayPlan | null {
  if (input.pin === true || input.userAsked === true || input.user_asked === true
    || (Array.isArray(input.items) && input.items.length > 0)) return null;
  const same = letters
    .filter((l) => l.awayThread?.taskId === mark.taskId && !l.archived && l.createdAt > (mark.since ?? 0)
      && now - l.createdAt < AWAY_THREAD_MAX_MS)
    .sort((a, b) => b.createdAt - a.createdAt);
  const thread = same.find((l) => l.type !== 'action_required' && !l.settled && l.sender.sessionId === sessionId);
  const unread = same.filter((l) => !l.read);
  // A thread's buzz of this absence is the absence's buzz too: he has not been back since.
  // Only one still waiting on him, and only inside the decision clock: it has no "read" to end it.
  const threadBuzzed = threadBuzzAt !== null && threadBuzzAt > (mark.since ?? 0) && now - threadBuzzAt < DECISION_QUIET_MS;
  if (input.type !== 'action_required') {
    if (thread) return { kind: 'fold', into: thread };
    return { kind: 'new', mark, quiet: unread.length > 0 || threadBuzzed };
  }
  // A decision: quiet only while the absence buzzed lately and he has not looked.
  const quiet = unread.some((l) => now - l.createdAt < DECISION_QUIET_MS) || threadBuzzed;
  return { kind: 'new', mark, quiet };
}

/** The thread line of a folded update: its subject, then its preview when it gave one. */
export function foldedTurnText(input: Pick<SendInput, 'subject' | 'text'>): string {
  const subject = String(input.subject ?? '').trim();
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  return text && text !== subject ? `${subject}: ${text}` : subject;
}

export interface AwaySendResult {
  letter: LetterRecord;
  /** The update joined the absence's thread (no new letter). */
  addedToThread: boolean;
}

/** One send at a time per node: two parallel letters would both start a thread and both buzz. */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

/**
 * Send `input` the away way when its sender is Main or a lead the user is away from; null = send it
 * as usual. `sendNew` sends a new letter with the given options (the store's sendLetterOnce).
 * `guard.refuseDuplicate` (a session's send, duplicate-letter.ts) runs again inside the node's
 * queue, and a folded update repeating the thread's latest turn is refused, never sent as a letter.
 */
export async function sendAway(
  input: SendInput,
  sender: LetterSender,
  sendNew: (opts: { awayThread: AwayThreadMark; quiet: boolean }) => Promise<LetterRecord>,
  now = Date.now(),
  guard: { refuseDuplicate?: () => Promise<void> } = {},
): Promise<AwaySendResult | null> {
  const taskId = sender.taskId;
  if (!taskId) return null;
  const store = await import('./store.js');
  // A letter the store would refuse is refused the same way, never folded half-checked.
  if (!store.checkLetterShape(input as unknown as Record<string, unknown>).ok) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const [task] = await listTasksByIds([taskId]).catch(() => []);
  if (!task || (task.org_role !== 'main' && task.org_role !== 'lead')) return null;
  return serial(taskId, async () => {
    const { userAwayFrom } = await import('../org/user-away.js');
    const state = await userAwayFrom(task, now);
    if (!state?.away) return null;
    const { readThreads } = await import('../org/threads-store.js');
    const { lastThreadBuzz } = await import('../push/thread-push.js');
    const threadBuzzAt = lastThreadBuzz((await readThreads(taskId).catch(() => ({ threads: [] }))).threads, state.lastSeenAt);
    const plan = planAwaySend(input, { taskId, since: state.lastSeenAt }, sender.sessionId, await store.awayLettersOf(taskId), now, threadBuzzAt);
    if (!plan) return null;
    // A new letter repeating one just sent is refused; an update folds into the thread (a turn
    // repeating the thread's latest is refused below).
    if (plan.kind !== 'fold') await guard.refuseDuplicate?.();
    const { log } = await import('../../logging/index.js');
    if (plan.kind === 'fold') {
      const ref = input.htmlRef ?? input.html_ref;
      try {
        const letter = await store.agentReply(plan.into.id, {
          text: foldedTurnText(input),
          ...(typeof input.markdown === 'string' && input.markdown ? { markdown: input.markdown }
            : typeof input.html === 'string' && input.html ? { html: input.html } : ref ? { htmlRef: ref } : {}),
        }, { quiet: !plan.into.read, taskRefs: input.taskRefs ?? input.task_refs, refuseDuplicate: !!guard.refuseDuplicate });
        log.notif.info('human-inbox: an away update joined its thread', { letterId: letter.id, taskId, quiet: !plan.into.read });
        return { letter, addedToThread: true };
      } catch (err) {
        // The same update twice: refused as the letter it was sent as, never a second letter.
        if (err instanceof store.LetterError && err.code === 'duplicate_reply') throw new store.LetterError(err.message, 'duplicate_letter', 409);
        // The thread went away under it (deleted, a size cap): a letter of its own instead.
        log.notif.warn('human-inbox: away update not folded, sent as a letter', { letterId: plan.into.id, error: err instanceof Error ? err.message : String(err) });
        return { letter: await sendNew({ awayThread: { taskId, since: state.lastSeenAt }, quiet: false }), addedToThread: false };
      }
    }
    return { letter: await sendNew({ awayThread: plan.mark, quiet: plan.quiet }), addedToThread: false };
  });
}
