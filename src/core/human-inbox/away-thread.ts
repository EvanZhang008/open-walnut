/**
 * One thread per absence: the letters Main or a lead sends while the user is away from its chat.
 *
 * 2026-10-31, the user before going to sleep: important updates go to his inbox while he is not in
 * the chat, and use the inbox's thread rather than many letters. So, from an org node the user is
 * away from (org/user-away.ts):
 *  - its first letter of the absence is sent as usual and marked (`awayThread`);
 *  - a later update (info, review, completion) joins that letter's thread as a turn, never a new letter;
 *  - a decision (action_required) stays its own letter, because its options are what one tap answers,
 *    and the thread gets one line naming it;
 *  - the phone buzzes once: nothing of the absence pushes while a letter of it is still unread. Once
 *    he has read it, the next turn buzzes again; a decision buzzes when the unread letter that did is
 *    older than DECISION_QUIET_MS, so a night's first letter never silences a morning decision.
 * The absence is "since he was last in the chat": a letter of it was made after that moment (so a
 * restart that forgets a heartbeat keeps the thread). A thread is used for AWAY_THREAD_MAX_MS, and only
 * by the session that wrote it (his answers in it go to that session). Pinned, mail items and a letter
 * the user asked for stand alone, as before.
 */
import type { AwayThreadMark, LetterRecord, LetterSender, NewLetter } from './types.js';

export const AWAY_THREAD_MAX_MS = 24 * 60 * 60_000;
export const DECISION_QUIET_MS = 3 * 60 * 60_000;

type SendInput = Omit<NewLetter, 'sender'>;

export type AwayPlan =
  | { kind: 'fold'; into: LetterRecord }
  | { kind: 'new'; mark: AwayThreadMark; quiet: boolean; noteInto?: LetterRecord };

/** Pure: how a letter from an away node goes out, given that node's open away letters. */
export function planAwaySend(
  input: Pick<SendInput, 'type' | 'pin' | 'items' | 'userAsked' | 'user_asked'>,
  mark: AwayThreadMark,
  sessionId: string,
  letters: readonly LetterRecord[],
  now: number,
): AwayPlan | null {
  if (input.pin === true || input.userAsked === true || input.user_asked === true
    || (Array.isArray(input.items) && input.items.length > 0)) return null;
  const same = letters
    .filter((l) => l.awayThread?.taskId === mark.taskId && !l.archived && l.createdAt > (mark.since ?? 0)
      && now - l.createdAt < AWAY_THREAD_MAX_MS)
    .sort((a, b) => b.createdAt - a.createdAt);
  const thread = same.find((l) => l.type !== 'action_required' && !l.settled && l.sender.sessionId === sessionId);
  const unread = same.filter((l) => !l.read);
  if (input.type !== 'action_required') {
    if (thread) return { kind: 'fold', into: thread };
    return { kind: 'new', mark, quiet: unread.length > 0 };
  }
  // A decision: quiet only while the absence buzzed lately and he has not looked.
  const quiet = unread.some((l) => now - l.createdAt < DECISION_QUIET_MS);
  return { kind: 'new', mark, quiet, ...(thread ? { noteInto: thread } : {}) };
}

/** The thread line of a folded update: its subject, then its preview when it gave one. */
export function foldedTurnText(input: Pick<SendInput, 'subject' | 'text'>): string {
  const subject = String(input.subject ?? '').trim();
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  return text && text !== subject ? `${subject}: ${text}` : subject;
}

export function decisionNoteText(subject: string): string {
  return `Needs your answer: "${subject.trim()}", in its own letter, where one tap answers it.`;
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
 */
export async function sendAway(
  input: SendInput,
  sender: LetterSender,
  sendNew: (opts: { awayThread: AwayThreadMark; quiet: boolean }) => Promise<LetterRecord>,
  now = Date.now(),
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
    const plan = planAwaySend(input, { taskId, since: state.lastSeenAt }, sender.sessionId, await store.awayLettersOf(taskId), now);
    if (!plan) return null;
    const { log } = await import('../../logging/index.js');
    if (plan.kind === 'fold') {
      const ref = input.htmlRef ?? input.html_ref;
      try {
        const letter = await store.agentReply(plan.into.id, {
          text: foldedTurnText(input),
          ...(typeof input.markdown === 'string' && input.markdown ? { markdown: input.markdown }
            : typeof input.html === 'string' && input.html ? { html: input.html } : ref ? { htmlRef: ref } : {}),
        }, { quiet: !plan.into.read, taskRefs: input.taskRefs ?? input.task_refs });
        log.notif.info('human-inbox: an away update joined its thread', { letterId: letter.id, taskId, quiet: !plan.into.read });
        return { letter, addedToThread: true };
      } catch (err) {
        // The thread went away under it (deleted, a size cap): a letter of its own instead.
        log.notif.warn('human-inbox: away update not folded, sent as a letter', { letterId: plan.into.id, error: err instanceof Error ? err.message : String(err) });
        return { letter: await sendNew({ awayThread: { taskId, since: state.lastSeenAt }, quiet: false }), addedToThread: false };
      }
    }
    const letter = await sendNew({ awayThread: plan.mark, quiet: plan.quiet });
    if (plan.noteInto) {
      await store.agentReply(plan.noteInto.id, { text: decisionNoteText(input.subject) }, { quiet: true })
        .catch((err) => log.notif.warn('human-inbox: away thread note not written', { letterId: plan.noteInto!.id, error: err instanceof Error ? err.message : String(err) }));
    }
    return { letter, addedToThread: false };
  });
}
