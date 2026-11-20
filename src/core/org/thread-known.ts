/**
 * A thread he acknowledged while work on it was not over (experiment ack_means_known, thread-ack.ts).
 * His Acknowledge is an action, not a place: thread-ack-outcome.ts ackOutcome says where the card
 * goes at once (2026-11-20, the user: "if I ack and ai should determine if it should go to closed
 * or wait or wip"):
 *
 *   closed   its result is delivered and nothing on its subject still runs or waits: it closes.
 *   working / waiting   work on its subject still runs, or it waits on someone or something: it
 *      goes pending with `ackedAt` (isKnown here), drawn under Working or Waiting / Snoozed as the
 *      read projects it (`ackGroup`), with what it waits on (`awaits`).
 *
 * When those waits end, the node hears it once (`ackDone` stamps that moment). It comes back to Done
 * only with something new for him (the node sets it answered); with nothing new it closes. The node
 * is asked to do that itself; when it has not, KNOWN_CLOSE_MS after the waits ended Walnut does
 * (knownStep). He writes in it: it is working again (threads-model.ts fileMessage).
 *
 * Pure and web-safe: the web and the server group by the same rule (thread-groups.ts).
 */
import { hasThreadNews, pinnedNow, snoozedNow, type ViewThread } from './thread-view.js';

/** After its waits ended, how long a Known thread with nothing new stays before Walnut closes it. */
export const KNOWN_CLOSE_MS = 10 * 60_000;

/** What a thread he acknowledged still waits on (thread-ack-outcome.ts ackOutcome; the read route adds `what`). */
export interface AckWaits {
  /** The tasks it lists still working or waiting on its subject: id, title, on a read what each is to finish, and a waiting one's waitingOn and until. */
  tasks: Array<{ id: string; title: string; what?: string; waitingOn?: string; until?: string }>;
  /** His reply on it has not reached the node's session yet. */
  replies: boolean;
  /** A decision letter it holds still waits. */
  letter: boolean;
}

type AckShape = Pick<ViewThread, 'closed' | 'ackedAt' | 'messages'> & { state: string };

/** He wrote nothing on it since his Acknowledge. */
const quietSinceAck = (t: AckShape): boolean => !!t.ackedAt && !t.messages.some((m) => m.at > t.ackedAt!);

/** He acknowledged it while its work ran, and it still waits (pending, open, no word of his since). Pure. */
export function isKnown(t: AckShape): boolean {
  return !t.closed && t.state === 'pending' && quietSinceAck(t);
}

/** It was Known and the node brought it back with something new (answered, no word of his since). Pure. */
export function backFromKnown(t: AckShape): boolean {
  return !t.closed && t.state === 'answered' && quietSinceAck(t);
}

/**
 * What Walnut does now about a thread he acknowledged, given whether anything is still open on it:
 *   none    it is not Known
 *   wait    its work still runs, or it ended less than KNOWN_CLOSE_MS ago
 *   rewait  it had ended (`ackDone`) and new work opened on it: the clock starts again when that ends
 *   tell    its waits just ended: the node hears it once, and the clock starts (`ackDone`)
 *   show    the node wrote something new but left it pending: back to Done
 *   close   nothing new: Walnut closes it
 * One he pinned or snoozed since his ack keeps it in his hands: Walnut neither shows nor closes it.
 * `shared`: the answers shared with another thread (thread-view.ts sharedAnswers), as his view reads news. Pure.
 */
export type KnownStep = 'none' | 'wait' | 'rewait' | 'tell' | 'show' | 'close';

export function knownStep(t: ViewThread & { state: string }, open: boolean, now: number, shared?: ReadonlySet<string>): KnownStep {
  if (!isKnown(t)) return 'none';
  if (open) return t.ackDone ? 'rewait' : 'wait';
  if (!t.ackDone) return 'tell';
  if (now - Date.parse(t.ackDone) < KNOWN_CLOSE_MS || pinnedNow(t) || snoozedNow(t, now)) return 'wait';
  return hasThreadNews(t, shared) ? 'show' : 'close';
}
