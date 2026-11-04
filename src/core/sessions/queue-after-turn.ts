/**
 * A message lined up for AFTER the running turn ("queue it", as against "steer it").
 *
 * A message sent while a turn runs is normally written into the live CLI at once and
 * reaches the model at its next tool boundary: the person cannot edit or withdraw it
 * any more. A send that carries `afterTurn` is held in the durable queue instead
 * (parked under AFTER_TURN_REASON, so no delivery path touches it) and goes out as the
 * next turn, one row at a time, when the running turn ends. Until then it is an
 * ordinary queued row that can be edited, withdrawn or sent now.
 *
 * Three things end a hold: the turn ends (`session:result` / `session:turn-settled`),
 * a person's Send now, or the sweep that finds the session idle (a crash, an idle
 * reap, a restart). A Stop that came after the row was held sets it aside the way it
 * sets every row aside, so a stopped session never starts its own backlog.
 */
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { log } from '../../logging/index.js';
import { AFTER_TURN_REASON } from '../relay-fates.js';
import type { QueuedMessage } from '../session-queue-store.js';

export { AFTER_TURN_REASON };

/** Quiet time after a turn-end event before the hold is looked at (the runner clears its own state in the same tick). */
const GRACE_MS = 400;
/** The sweep's lap while any hold exists. */
const SWEEP_MS = 30_000;
/** A sweep never releases a second row this soon after the first (its turn may not have registered yet). */
const RELEASE_GAP_MS = 20_000;

export function isAfterTurnHold(row: Pick<QueuedMessage, 'status' | 'parkedReason'>): boolean {
  return row.status === 'parked' && row.parkedReason === AFTER_TURN_REASON;
}

/** The queue as a person reads it: a row waiting for the turn to end is simply pending. */
export function presentAfterTurn<T extends Pick<QueuedMessage, 'status' | 'parkedReason' | 'parkedAt'>>(row: T): T & { afterTurn?: true } {
  if (!isAfterTurnHold(row)) return row;
  const { parkedAt: _parkedAt, parkedReason: _parkedReason, ...rest } = row;
  return { ...rest, status: 'pending', afterTurn: true } as unknown as T & { afterTurn?: true };
}

async function turnRunning(sessionId: string): Promise<boolean> {
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  return sessionRunner.isTurnRunning(sessionId);
}

/**
 * Should a send that asked to wait for the turn's end be held? Only while a turn runs, and never
 * while the turn waits on a permission prompt: that turn cannot end until the person answers,
 * and their typed words are how they answer it.
 */
export async function holdsForRunningTurn(sessionId: string): Promise<boolean> {
  if (!(await turnRunning(sessionId))) return false;
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  return !sessionRunner.hasPendingPermission(sessionId);
}

const watching = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const releasedAt = new Map<string, number>();
let sweep: ReturnType<typeof setInterval> | null = null;
let subscribed = false;

/** A hold exists on this session: look at it when the turn ends, and keep a sweep for the turn end nobody reports. */
export function noteAfterTurnHold(sessionId: string): void {
  watching.add(sessionId);
  armSweep();
  // The turn may have ended between the check that held the row and the row being stored.
  scheduleAfterTurnRelease(sessionId, GRACE_MS, true);
}

function armSweep(): void {
  if (sweep || watching.size === 0) return;
  sweep = setInterval(() => {
    for (const sid of [...watching]) scheduleAfterTurnRelease(sid, 0, false);
  }, SWEEP_MS);
  sweep.unref?.();
}

function disarmSweepIfIdle(): void {
  if (watching.size > 0 || !sweep) return;
  clearInterval(sweep);
  sweep = null;
}

/** A turn-end event can arrive a tick before the runner lets go of the turn: look again a few times. */
const EVENT_RETRIES = 6;
const EVENT_RETRY_MS = 500;

export function scheduleAfterTurnRelease(sessionId: string, delayMs = GRACE_MS, viaEvent = true, attempt = 0): void {
  if (timers.has(sessionId)) return;
  const timer = setTimeout(() => {
    timers.delete(sessionId);
    releaseAfterTurn(sessionId, { viaEvent }).then((outcome) => {
      if (outcome === 'running' && viaEvent && attempt < EVENT_RETRIES) {
        scheduleAfterTurnRelease(sessionId, EVENT_RETRY_MS, true, attempt + 1);
      }
    }).catch((err) => {
      log.session.warn('queue after turn: release failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    });
  }, delayMs);
  timer.unref?.();
  timers.set(sessionId, timer);
}

export type ReleaseOutcome = 'none' | 'running' | 'busy' | 'stopping' | 'stopped' | 'released';

/**
 * Send the oldest held row of this session as the next turn, if its turn has ended.
 * Never while a turn runs, never beside another row already on its way in (an Interrupt &
 * send, a Send now), never over a Stop that came after the row was held.
 */
export async function releaseAfterTurn(sessionId: string, opts?: { viaEvent?: boolean }): Promise<ReleaseOutcome> {
  const { getQueue } = await import('../session-message-queue.js');
  const queue = await getQueue(sessionId);
  const held = queue.filter(isAfterTurnHold);
  if (held.length === 0) {
    watching.delete(sessionId);
    disarmSweepIfIdle();
    return 'none';
  }
  if (await turnRunning(sessionId)) return 'running';
  if (queue.some((row) => row.status === 'pending' || row.status === 'processing')) return 'busy';
  if (!opts?.viaEvent && Date.now() - (releasedAt.get(sessionId) ?? 0) < RELEASE_GAP_MS) return 'busy';

  const { sessionStops } = await import('./session-stop.js');
  let fence: string | null;
  try {
    fence = await sessionStops.fence(sessionId);
  } catch {
    return 'stopping';
  }
  const { setAsideHeld } = await import('../session-queue-park.js');
  await setAsideHeld(sessionId, fence);
  const next = held.find((row) => (row.stopFence ?? null) === fence);
  if (!next) return 'stopped';

  const { sendQueuedNow } = await import('./send-now.js');
  const sent = await sendQueuedNow({
    messageId: next.id,
    sessionId,
    // Whoever typed the words sent them: the delivery keeps that provenance.
    source: next.sentBy === 'person' ? 'mobile' : 'api-agent',
    unpark: true,
  });
  releasedAt.set(sessionId, Date.now());
  if (sent.sent) log.session.info('queue after turn: held message released', { sessionId, messageId: next.id });
  return 'released';
}

/** A person's Stop came: every row held for the turn's end is set aside like the rest. */
export async function setAsideAfterTurnHolds(sessionId: string): Promise<number> {
  const { setAsideHeld } = await import('../session-queue-park.js');
  return setAsideHeld(sessionId);
}

function onTurnEnd(event: BusEvent): void {
  const sessionId = (event.data as { sessionId?: string } | undefined)?.sessionId;
  if (!sessionId || !watching.has(sessionId)) return;
  scheduleAfterTurnRelease(sessionId, GRACE_MS, true);
}

const SUBSCRIBER = 'queue-after-turn';

/** Boot: look for holds a restart left behind (their turn is gone), and listen for turn ends. */
export async function startQueueAfterTurn(): Promise<void> {
  if (!subscribed) {
    subscribed = true;
    bus.subscribe(SUBSCRIBER, onTurnEnd, {
      global: true,
      interest: [EventNames.SESSION_RESULT, EventNames.SESSION_TURN_SETTLED, EventNames.SESSION_ERROR],
    });
  }
  const { sessionsWithHeld } = await import('../session-queue-park.js');
  for (const sid of await sessionsWithHeld()) {
    watching.add(sid);
    scheduleAfterTurnRelease(sid, 2_000, false);
  }
  armSweep();
}

export function stopQueueAfterTurn(): void {
  bus.unsubscribe(SUBSCRIBER);
  subscribed = false;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  watching.clear();
  releasedAt.clear();
  if (sweep) clearInterval(sweep);
  sweep = null;
}
