/**
 * Known: a thread he acknowledged while its work was not finished (experiment ack_means_known,
 * thread-ack.ts; 2026-11-20, the user: "I ack, she sees it herself, nothing else, so it closes,
 * right?"). Two cases at his Acknowledge:
 *
 *   A  the card already holds the result (answered): it closes for good, whatever is still open.
 *   B  its work still runs (thread-ack.ts ackWaitsOf): it goes pending with `ackedAt` and is Known,
 *      drawn in its own group with what it waits on (`awaits`, projected on read).
 *
 * When B's waits end, the node hears it once (`ackDone` stamps that moment). It comes back to To
 * read only with something new for him (the node sets it answered); with nothing new it closes. The
 * node is asked to do that itself; when it has not, KNOWN_CLOSE_MS after the waits ended Walnut does
 * (knownStep). He writes in it: it is working again and leaves Known (threads-model.ts fileMessage).
 *
 * Pure and web-safe: the web and the server group by the same rule (thread-groups.ts).
 */
import { hasThreadNews, type ViewThread } from './thread-view.js';

/** After its waits ended, how long a Known thread with nothing new stays before Walnut closes it. */
export const KNOWN_CLOSE_MS = 10 * 60_000;

/** What a Known thread still waits on (thread-ack.ts ackWaitsOf; the read route adds `what`). */
export interface AckWaits {
  /** The tasks it lists that are not COMPLETE: id, title, and on a read what each is to finish. */
  tasks: Array<{ id: string; title: string; what?: string }>;
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
 *   show    the node wrote something new but left it pending: back to To read
 *   close   nothing new: Walnut closes it
 * Pure.
 */
export type KnownStep = 'none' | 'wait' | 'rewait' | 'tell' | 'show' | 'close';

export function knownStep(t: ViewThread & { state: string }, open: boolean, now: number): KnownStep {
  if (!isKnown(t)) return 'none';
  if (open) return t.ackDone ? 'rewait' : 'wait';
  if (!t.ackDone) return 'tell';
  if (now - Date.parse(t.ackDone) < KNOWN_CLOSE_MS) return 'wait';
  return hasThreadNews(t) ? 'show' : 'close';
}
