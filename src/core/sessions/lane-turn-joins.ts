/**
 * Messages sent into a running lane turn (runLaneTurn's `onJoinable`).
 *
 * A person who writes again while the Personal AI answers them expects the words to
 * go in at once, as a session's do (2026-11-09, the owner, of the phone's Chat tab:
 * "不要queue了 就像网页版也一样直接发出去"). Sending into a busy lane from outside the
 * turn is what glued two turns' answers together (2026-09-26, lane-turn-gate.ts), so
 * the turn itself takes the message: it decides synchronously whether it still can,
 * sends it to its own lane, and does not end until every message it took has an
 * answer of its own.
 *
 * When is a joined message answered? By the first result the lane emits after the
 * CLI TOOK its line: the CLI's `command_lifecycle started` (SESSION_USER_LINE, read
 * from the stream in order with the results), at a tool boundary inside the running
 * turn or at the start of a turn of its own. The write is not that moment: a line
 * written mid-turn waits in the CLI's own queue, and when the model is writing its
 * last words the CLI ends the turn first and runs the line next, so a result read
 * after the write may answer only the turn's own message (the review of 2026-11-09).
 * A CLI that never reports its queue has no such word; for it alone the write is the
 * delivery, and a result of the same or a later generation answers it, the rule the
 * runner had before lifecycle frames existed.
 *
 * A message that leaves the line without running (parked, cancelled by a Stop,
 * withdrawn) is not waited for.
 */
import { log } from '../../logging/index.js';

/** The handle a running lane turn hands its caller (runLaneTurn opts.onJoinable). */
export interface LaneTurnJoiner {
  /**
   * Take `text` into this turn. Decided synchronously: null when the turn can no
   * longer take a message (its own message is not with the CLI yet, it is ending,
   * it failed, it took the most it takes). Otherwise the promise settles once the
   * message is in the lane's queue; it rejects when the send failed, and the turn
   * no longer waits for it. `onWritten` runs once, when the CLI is first written the
   * message (or took it): one that leaves the line unrun never calls it.
   */
  offer(text: string, messageId: string, onWritten?: () => void): Promise<void> | null;
}

/** At most this many messages go into one turn; past it, they wait for the next. */
export const MAX_JOINS_PER_TURN = 20;

export interface Joined {
  id: string;
  /** Written to the CLI (SESSION_MESSAGES_DELIVERED). */
  delivered: boolean;
  deliveredGen?: number;
  /** The CLI took the line (SESSION_USER_LINE). */
  taken: boolean;
  /** This lane's CLI reports its queue (its session record says so). */
  reportsQueue: boolean;
  answered: boolean;
  /** Runs once, at the first write or take (offer's `onWritten`). */
  onWritten?: () => void;
}

/** Bound on ids remembered for a join whose queue id is not known yet. */
const SEEN_MAX = 50;

export class LaneTurnJoins {
  private readonly joins: Joined[] = [];
  private readonly answers: string[] = [];
  private readonly deliveredSeen = new Map<string, number | undefined>();
  private readonly takenSeen = new Set<string>();
  /** The lane named a line taken during this turn: its CLI reports its queue. */
  private sawLineTaken = false;
  private ownAnswered = false;

  /** Messages taken into the turn and still waited for or answered. */
  get count(): number { return this.joins.length; }

  /** The turn's own message has its answer. */
  get answeredOwn(): boolean { return this.ownAnswered; }

  /** Every message the turn took has its answer, its own included. */
  get settled(): boolean { return this.ownAnswered && this.joins.every((j) => j.answered); }

  /** Messages still without an answer. */
  get pending(): number { return this.joins.filter((j) => !j.answered).length; }

  /** Register a message before it is sent, so an event that beats the send's answer still counts. */
  add(id: string, onWritten?: () => void): Joined {
    const joined: Joined = { id, delivered: false, taken: false, reportsQueue: false, answered: false, onWritten };
    this.joins.push(joined);
    this.catchUp(joined);
    return joined;
  }

  /** The message left the line without running, or its send failed: not waited for. */
  remove(joined: Joined): void {
    const at = this.joins.indexOf(joined);
    if (at >= 0) this.joins.splice(at, 1);
  }

  /** The queue named another id than the one asked for (an engine switch moved it). */
  rename(joined: Joined, id: string): void {
    if (joined.id === id) return;
    joined.id = id;
    this.catchUp(joined);
  }

  /** The CLI was written these queue rows (SESSION_MESSAGES_DELIVERED). */
  noteDelivered(ids: readonly string[], turnGen: number | undefined): void {
    for (const id of ids) {
      const joined = this.find(id);
      if (joined) {
        if (!joined.delivered) { joined.delivered = true; joined.deliveredGen = turnGen; this.wrote(joined); }
        continue;
      }
      remember(this.deliveredSeen, id, turnGen);
    }
  }

  /** The CLI took the line carrying these rows (SESSION_USER_LINE). */
  noteTaken(rowIds: readonly string[]): void {
    this.sawLineTaken = true;
    for (const id of rowIds) {
      const joined = this.find(id);
      if (joined) { this.markTaken(joined); continue; }
      if (this.takenSeen.size >= SEEN_MAX) this.takenSeen.delete(this.takenSeen.values().next().value as string);
      this.takenSeen.add(id);
    }
  }

  /** These rows left the line without running (parked, cancelled): not waited for.
   *  One the CLI was written or took is with the CLI, and still waited for. */
  noteDropped(ids: readonly string[]): Joined[] {
    const dropped = this.joins.filter((j) => ids.includes(j.id) && !j.answered && !j.delivered && !j.taken);
    for (const j of dropped) this.remove(j);
    return dropped;
  }

  /** These rows went back to the line after a failed write (a retry follows): the
   *  write that was reported is not a delivery any more. */
  noteUndelivered(ids: readonly string[]): void {
    for (const j of this.joins) {
      if (!ids.includes(j.id) || j.answered || j.taken) continue;
      j.delivered = false
      j.deliveredGen = undefined
    }
  }

  /** A result of this turn's lane, after the turn's own message was delivered. */
  noteResult(text: string, turnGen: number | undefined): void {
    this.ownAnswered = true;
    if (text.trim()) this.answers.push(text);
    for (const j of this.joins) {
      if (j.answered) continue;
      if (j.taken) { j.answered = true; continue; }
      // A CLI that reports its queue answers a line only after it took it.
      if (this.sawLineTaken || j.reportsQueue || !j.delivered) continue;
      if (turnGen !== undefined && j.deliveredGen !== undefined && turnGen < j.deliveredGen) continue;
      j.answered = true;
    }
  }

  /** Joins still waited for that the CLI was never written (a withdraw or a park candidate). */
  unwritten(): Joined[] {
    return this.joins.filter((j) => !j.answered && !j.delivered && !j.taken);
  }

  /** The answers so far, in the order the lane gave them; null when there is none. */
  text(): string | null {
    return this.answers.length > 0 ? this.answers.join('\n\n') : null;
  }

  /** For the log: what the turn still waits for. */
  waiting(): { unwritten: string[]; untaken: string[]; unanswered: string[] } {
    const open = this.joins.filter((j) => !j.answered);
    return {
      unwritten: open.filter((j) => !j.delivered && !j.taken).map((j) => j.id),
      untaken: open.filter((j) => j.delivered && !j.taken).map((j) => j.id),
      unanswered: open.filter((j) => j.taken).map((j) => j.id),
    };
  }

  private find(id: string): Joined | undefined {
    return this.joins.find((j) => j.id === id);
  }

  private catchUp(joined: Joined): void {
    if (!joined.delivered && this.deliveredSeen.has(joined.id)) {
      joined.delivered = true;
      joined.deliveredGen = this.deliveredSeen.get(joined.id);
      this.wrote(joined);
    }
    if (!joined.taken && this.takenSeen.has(joined.id)) this.markTaken(joined);
  }

  private markTaken(joined: Joined): void {
    if (joined.taken) return;
    joined.taken = true;
    joined.delivered = true;
    this.wrote(joined);
    log.session.info('lane turn: the CLI took a message sent into the turn', { messageId: joined.id });
  }

  private wrote(joined: Joined): void {
    const cb = joined.onWritten;
    if (!cb) return;
    joined.onWritten = undefined;
    try { cb(); } catch { /* the caller's bookkeeping never stops the turn */ }
  }
}

function remember(map: Map<string, number | undefined>, id: string, gen: number | undefined): void {
  if (map.size >= SEEN_MAX) map.delete(map.keys().next().value as string);
  map.set(id, gen);
}
