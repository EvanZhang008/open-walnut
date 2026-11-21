/**
 * A thread he acknowledged while it was still open (experiment ack_means_known, thread-ack.ts).
 * His Acknowledge sends the card at once to Acknowledged, a place it only passes through: the
 * node's AI decides where it goes (2026-11-20, the user: "if I ack and ai should determine if it
 * should go to closed or wait or wip", then "put it in Acknowledged ... keep Acknowledged, simpler"):
 *
 *   Acknowledged   pending with `ackedAt` and no `ackPlaced`: "AI is deciding where this goes."
 *   placed         the node's thread_update `place` (closed, waiting with what it waits on, or
 *                  working) records `ackPlaced` with its why; the card says where it went and why.
 *   fallback       the node has not decided KNOWN_CLOSE_MS after his ack: Walnut places it by
 *                  thread-ack-outcome.ts ackOutcome (knownStep 'place', settleKnown) and logs it.
 *
 * One Walnut placed in Waiting or Working is settled the way Known was: when its waits end the node
 * hears it once (`ackDone`), and KNOWN_CLOSE_MS later it comes back to Done with something new or
 * closes. One the node placed is the node's, like any thread it set pending. He writes in it: it is
 * working again (threads-model.ts fileMessage).
 *
 * Pure and web-safe: the web and the server group by the same rule (thread-groups.ts).
 */
import { hasThreadNews, pinnedNow, snoozedNow, type AckPlace, type AckPlaced, type ViewThread } from './thread-view.js';

/**
 * How long the node has to place a thread he acknowledged before Walnut does, and how long one
 * Walnut placed stays after its waits ended before Walnut closes it with nothing new.
 */
export const KNOWN_CLOSE_MS = 10 * 60_000;

export { ACK_PLACES, type AckPlace, type AckPlaced } from './thread-view.js';

/** What a thread he acknowledged still waits on (thread-ack-outcome.ts ackOutcome; the read route adds `what`). */
export interface AckWaits {
  /** The tasks it lists still working or waiting on its subject: id, title, on a read what each is to finish, and a waiting one's waitingOn and until. */
  tasks: Array<{ id: string; title: string; what?: string; waitingOn?: string; until?: string }>;
  /** His reply on it has not reached the node's session yet. */
  replies: boolean;
  /** A decision letter it holds still waits. */
  letter: boolean;
}

type AckShape = Pick<ViewThread, 'closed' | 'ackedAt' | 'messages' | 'ackPlaced'> & { state: string };

/** He wrote nothing on it since his Acknowledge. */
const quietSinceAck = (t: AckShape): boolean => !!t.ackedAt && !t.messages.some((m) => m.at > t.ackedAt!);

/** He acknowledged it while its work ran, and it still waits (pending, open, no word of his since). Pure. */
export function isKnown(t: AckShape): boolean {
  return !t.closed && t.state === 'pending' && quietSinceAck(t);
}

/** Its placement since his last Acknowledge, if any (one from an earlier ack does not count). Pure. */
export function placedSinceAck(t: Pick<AckShape, 'ackedAt' | 'ackPlaced'>): AckPlaced | null {
  return t.ackedAt && t.ackPlaced && t.ackPlaced.at >= t.ackedAt ? t.ackPlaced : null;
}

/** In Acknowledged: he acknowledged it and nobody placed it yet. Pure. */
export function inAcknowledged(t: AckShape): boolean {
  return isKnown(t) && !placedSinceAck(t);
}

/** The card's words while the AI decides. */
export const ACK_DECIDING_LINE = 'AI is deciding where this goes.';
/** Short names of the places, as the card's line says them ("Moved to Waiting: ..."). */
export const ACK_PLACE_WORDS: Record<AckPlace, string> = { working: 'Working', waiting: 'Waiting', closed: 'Closed' };

/**
 * The one line his card carries about his Acknowledge: in Acknowledged the deciding line; placed,
 * where it went and why ("Moved to Waiting: waits on the simulator until 22:00"; Walnut's own
 * placement says so); null on any other card (he wrote in it since, or it reopened). Pure.
 */
export function ackCardLine(t: AckShape): string | null {
  if (inAcknowledged(t)) return ACK_DECIDING_LINE;
  const p = placedSinceAck(t);
  if (!p) return null;
  const shows = p.to === 'closed' ? !!t.closed && quietSinceAck(t) : isKnown(t);
  if (!shows) return null;
  return `Moved to ${ACK_PLACE_WORDS[p.to]}${p.by === 'walnut' ? ' by Walnut' : ''}${p.why ? `: ${p.why}` : '.'}`;
}

/** It was Known and the node brought it back with something new (answered, no word of his since). Pure. */
export function backFromKnown(t: AckShape): boolean {
  return !t.closed && t.state === 'answered' && quietSinceAck(t);
}

/**
 * What Walnut does now about a thread he acknowledged, given whether anything is still open on it:
 *   none    it is not Known, or the node placed it (the node's from then on)
 *   wait    in Acknowledged less than KNOWN_CLOSE_MS; or placed by Walnut and its work still runs,
 *           or it ended less than KNOWN_CLOSE_MS ago
 *   place   in Acknowledged KNOWN_CLOSE_MS and the node has not decided: Walnut places it by its rule
 *   rewait  it had ended (`ackDone`) and new work opened on it: the clock starts again when that ends
 *   tell    its waits just ended: the node hears it once, and the clock starts (`ackDone`)
 *   show    the node wrote something new but left it pending: back to Done
 *   close   nothing new: Walnut closes it
 * One he pinned or snoozed since his ack keeps it in his hands: Walnut neither shows nor closes it.
 * `shared`: the answers shared with another thread (thread-view.ts sharedAnswers), as his view reads news. Pure.
 */
export type KnownStep = 'none' | 'wait' | 'place' | 'rewait' | 'tell' | 'show' | 'close';

export function knownStep(t: ViewThread & { state: string }, open: boolean, now: number, shared?: ReadonlySet<string>): KnownStep {
  if (!isKnown(t)) return 'none';
  const placed = placedSinceAck(t);
  if (!placed) return now - Date.parse(t.ackedAt!) < KNOWN_CLOSE_MS ? 'wait' : 'place';
  if (placed.by === 'node') return 'none';
  if (open) return t.ackDone ? 'rewait' : 'wait';
  if (!t.ackDone) return 'tell';
  if (now - Date.parse(t.ackDone) < KNOWN_CLOSE_MS || pinnedNow(t) || snoozedNow(t, now)) return 'wait';
  return hasThreadNews(t, shared) ? 'show' : 'close';
}
