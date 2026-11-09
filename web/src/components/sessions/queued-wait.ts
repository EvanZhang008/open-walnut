/**
 * The plain line under a queued bubble that has waited too long, and under one
 * the queue lost track of. Pure.
 *
 * 2026-11-09, the user: "everything shows queued, why does every session freeze
 * without any warning". A bubble read QUEUED for 40 minutes and nothing said why.
 * Past QUEUED_WHY_AFTER_MS a waiting bubble says why it waits (the server's
 * reason when it gave one) and how long, and what Walnut does about it.
 */

/** A bubble that has waited this long says why. */
export const QUEUED_WHY_AFTER_MS = 60_000;
/** A bubble that left the queue this long ago and history still lacks says so. */
export const LEFT_QUEUE_NOTE_AFTER_MS = 60_000;

export interface WaitLineInput {
  status: string;
  /** The enqueue time (the server's clock once the send answered). */
  timestamp?: string;
  /** The server's own reason for holding it (session:delivery-held, the queue's heldReason). */
  heldReason?: string;
  /** It waits for the running turn to end (the queue's afterTurn). */
  afterTurn?: boolean;
}

export interface WaitLineContext {
  now: number;
  /** A turn runs in the session now. */
  turnRunning: boolean;
  /** The panel's last read of the queue failed with this. */
  syncError?: string;
}

/** "45 s" / "3 min" / "2 h 5 min". */
export function waitedFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** How long it has waited, or null when its time is unknown. */
export function waitedMs(timestamp: string | undefined, now: number): number | null {
  const t = Date.parse(timestamp ?? '');
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

/**
 * The line for a waiting bubble, or null while it is young (or not waiting).
 * A held bubble already shows the server's reason (the held note); this adds
 * only how long, so the two never say the same twice.
 */
export function queuedWaitLine(m: WaitLineInput, ctx: WaitLineContext): string | null {
  if (m.status !== 'received' && m.status !== 'pending') return null;
  const waited = waitedMs(m.timestamp, ctx.now);
  if (waited === null || waited < QUEUED_WHY_AFTER_MS) return null;
  const since = `Queued ${waitedFor(waited)} ago.`;
  if (m.heldReason) return since;
  if (ctx.syncError) {
    return `Not sent yet. ${since} Walnut could not read its queue to check (${ctx.syncError}); it keeps trying.`;
  }
  if (m.afterTurn) {
    return `Waiting for the current turn to end. ${since} Walnut sends it as soon as the turn ends.`;
  }
  if (ctx.turnRunning) {
    return `Not sent yet: the session is busy with a turn and has not taken it. ${since} Walnut sends it when the session is ready; Send now tries at once.`;
  }
  return `Not sent yet: the session has not taken it. ${since} Walnut sends it when the session is ready; Send now tries at once.`;
}

/** The line for a bubble that left the queue but that history does not show, or null. */
export function leftQueueLine(m: { status: string; leftQueueAt?: number }, now: number): string | null {
  if (m.status !== 'delivered' || m.leftQueueAt === undefined) return null;
  if (now - m.leftQueueAt < LEFT_QUEUE_NOTE_AFTER_MS) return null;
  return 'Walnut no longer has this message queued, and it does not show in the conversation. It may not have reached the session; Send again sends it once more.';
}
