/**
 * Messages that wait for a cold session's next wake (2026-11-16, the user on the wake cost report:
 * "如果这个东西已经是啊 cold 了。那我觉得我们是不是应该 buffer 一下？不不能就有一个东西有有一个
 * message，我们就直接直接让他去啊 act"; the Walnut VP's order: cache-aware delivery, one shared
 * classifier, a visible hold, nothing ever dropped).
 *
 * A wake of a session idle past its prompt cache's lifetime writes its whole context to the cache
 * again: about $3.50 for a 400K session, ten times a warm turn. In the week of 11-08 to 11-15 such
 * cold wakes were 2,182 turns and $6,174, 46% of the wake cost. A message that can wait
 * (wake-policy.ts waitsWhenCold: a task's FYI, a re-check, news on a linked change; never a wake the
 * task armed for itself, its trigger's fire or its wait clock, wake-policy.ts isArmedWake) to a
 * session that is cold (sessionIsCold) is stored in the session's queue parked under
 * COLD_HOLD_REASON: on disk like every queued row, so a restart loses nothing, and shown in the panel
 * as a queued message that says it is held and until when. No delivery path touches a parked row.
 *
 * What ends a hold, all of the session's held rows at once and in their order, so they go out as
 * ONE line (one turn):
 *  - a message that cannot wait (the user's words, an ask, a reply, an alert): the held rows are put
 *    back in line in front of it, in the same send (session-message-queue.ts sendMessageToSession);
 *  - any send while the session is warm or running, and the sweep finding it so (a turn it started by
 *    itself, a background job's notice): the cache is warm, so the rows cost a warm read;
 *  - the oldest held row reaching COLD_HOLD_MAX_MS (the sweep);
 *  - a person's Send now on one of them, or an agent's (send-now.ts): every held row goes with it.
 * A Stop sets them aside like every row it stops (session-queue-park.ts setAsideHeld).
 */
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import { demoAdmissionClosed } from './demo-admission.js';
import { COLD_HOLD_REASON } from '../relay-fates.js';
import { leaveParked } from '../queue-held-spans.js';
import { mutateStore, readQueueFileFresh, type QueuedMessage } from '../session-queue-store.js';

export { COLD_HOLD_REASON };

/**
 * The longest a message waits for a cold session's next wake. Picked from the 11-08..15 week
 * (report/sim_buffer.py over both hosts' wakes): held messages reach their max hold far more often
 * than something else wakes the session first, so the saving grows with the hold: about $165 a
 * week at 30 min, $290 at 60, $430 at 2 h. The Walnut VP's range was 30 to 60 min; news on a
 * linked change (a CI result, a review) waits at most this long. A task's own trigger fire or wait
 * clock is never held (2026-11-18: a 20:00 timer reached its session an hour late); those savings
 * counted them as held, so they are lower now (they were most of the holds: 175 of 237 on 11-17/18).
 */
export const COLD_HOLD_MAX_MS = 60 * 60_000;
/** The sweep's lap while any session holds a row. */
const SWEEP_MS = 60_000;

export function isColdHold(row: Pick<QueuedMessage, 'status' | 'parkedReason'>): boolean {
  return row.status === 'parked' && row.parkedReason === COLD_HOLD_REASON;
}

/** When a held row goes out at the latest (epoch ms): its own park time plus the max hold. */
export function coldHoldReleaseAt(row: Pick<QueuedMessage, 'parkedAt' | 'enqueuedAt'>): number {
  const at = Date.parse(row.parkedAt ?? row.enqueuedAt);
  return (Number.isFinite(at) ? at : Date.now()) + COLD_HOLD_MAX_MS;
}

/**
 * The queue as the panel reads it: a held row is a queued message that says why it waits and when
 * it goes out at the latest (the panel's held note, heldReason and heldRetryAt).
 */
export function presentColdHold<T extends Pick<QueuedMessage, 'status' | 'parkedReason' | 'parkedAt' | 'enqueuedAt'>>(
  row: T, heldFirst?: Pick<QueuedMessage, 'parkedAt' | 'enqueuedAt'>,
): T & { heldReason?: string; heldRetryAt?: string; coldHold?: true } {
  if (!isColdHold(row)) return row;
  const { parkedAt: _p, parkedReason: _r, ...rest } = row;
  // Every held row of the session goes when the oldest one does; the panel shows that time in the
  // reader's own clock (heldRetryAt), so the words carry none.
  const by = new Date(coldHoldReleaseAt(heldFirst ?? row));
  return {
    ...rest,
    status: 'pending',
    coldHold: true,
    heldReason: 'Held: the session is idle and its prompt cache has expired, so this goes with its next wake, or by itself at the next try.',
    heldRetryAt: by.toISOString(),
  } as unknown as T & { heldReason?: string; heldRetryAt?: string; coldHold?: true };
}

/** Present every row of one session's queue (presentColdHold with the oldest held row's time). */
export function presentColdHolds<T extends Pick<QueuedMessage, 'status' | 'parkedReason' | 'parkedAt' | 'enqueuedAt'>>(rows: T[]): Array<T & { heldReason?: string; heldRetryAt?: string; coldHold?: true }> {
  const first = rows.find(isColdHold);
  return rows.map((r) => presentColdHold(r, first));
}

/** How the panel shows one held row of a session (presentColdHolds over its queue), or undefined. */
export async function heldViewOf(sessionId: string, messageId: string): Promise<{ heldReason?: string; heldRetryAt?: string } | undefined> {
  const { getQueue } = await import('../session-message-queue.js');
  return presentColdHolds(await getQueue(sessionId)).find((m) => m.id === messageId);
}

async function turnRunning(sessionId: string, processStatus: string | undefined): Promise<boolean> {
  if (processStatus === 'running') return true;
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  return sessionRunner.isTurnRunning(sessionId);
}

/**
 * Is this session cold: no turn runs, and its prompt cache's lifetime has passed (its last request
 * plus the lifetime that request wrote, sessions/prompt-cache.ts). Not when that is unknown (a
 * session that never ran, another engine): a message is never held on a guess.
 */
export async function sessionIsCold(sessionId: string, now = Date.now()): Promise<boolean> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(sessionId).catch(() => null);
  const expires = Date.parse(rec?.promptCache?.expiresAt ?? '');
  if (!rec || !Number.isFinite(expires) || expires > now) return false;
  return !(await turnRunning(sessionId, rec.process_status));
}

/** What a release put back in line: how many rows, and the send that delivers them. */
export interface ColdRelease {
  count: number;
  /** The source the delivery goes under: a held send's that ends the task's wait, else the first one's. */
  source?: string;
  /** A held send ends the task's wait (news a watcher sent with endsWait): the delivery does too. */
  endsWait?: true;
}

/**
 * Put every held row of the session back in line, in its place, in one write: fresh rows, so the
 * runner sends them together as one line. The caller asks for the delivery (a SESSION_SEND), or
 * its own send does.
 */
export async function releaseColdHolds(sessionId: string, why: string): Promise<ColdRelease> {
  // Read first: nearly every send finds nothing held, and then writes nothing.
  const { getQueue } = await import('../session-message-queue.js');
  if (!(await getQueue(sessionId)).some(isColdHold)) return { count: 0 };
  const now = Date.now();
  const sends = await mutateStore((s) => {
    const out: Array<{ id: string; source: string; endsWait?: true }> = [];
    for (const row of s.queues[sessionId] ?? []) {
      if (!isColdHold(row)) continue;
      out.push({ id: row.id, source: row.coldSend?.source ?? 'cold-hold', ...(row.coldSend?.endsWait ? { endsWait: true as const } : {}) });
      leaveParked(row, now);
      row.status = 'pending';
    }
    return out;
  });
  if (!sends.length) return { count: 0 };
  const { waitExitCause } = await import('../task-wait-resume.js');
  const ending = sends.find((x) => x.endsWait || waitExitCause('session:input', x.source, false) === null);
  log.session.info('cold hold: held messages go out', { sessionId, why, count: sends.length, messageIds: sends.map((x) => x.id) });
  return { count: sends.length, source: (ending ?? sends[0]).source, ...(ending ? { endsWait: true as const } : {}) };
}

/** Ask the runner to send rows a release put back in line, under the source their own sends had. */
export function sendReleased(sessionId: string, r: ColdRelease): void {
  if (r.count === 0 || demoAdmissionClosed()) return;
  bus.emit(EventNames.SESSION_SEND, { sessionId, message: '', ...(r.endsWait ? { endsWait: true } : {}) }, ['session-runner'], { source: r.source ?? 'cold-hold' });
}

/** Release the session's held rows and ask the runner to send them, as their own sends would have. */
export async function releaseAndSend(sessionId: string, why: string): Promise<number> {
  const r = await releaseColdHolds(sessionId, why);
  sendReleased(sessionId, r);
  return r.count;
}

let sweep: ReturnType<typeof setInterval> | null = null;
let lap: Promise<void> | null = null;

/** A row was held: the sweep runs until no session holds one. */
export function noteColdHold(_sessionId: string): void {
  armSweep();
}

function armSweep(): void {
  if (sweep) return;
  sweep = setInterval(() => { void sweepColdHolds(); }, SWEEP_MS);
  sweep.unref?.();
}

/**
 * One look at every session whose queue holds a row (read from the store each lap, so a queue an
 * engine switch or a move carried to a new session id is seen there): those whose oldest row
 * reached its max hold, those holding a row the classifier no longer holds, and those no longer
 * cold (a turn runs, or one ran and the cache is warm), send them now. One lap at a time; the sweep stops when no row is held.
 */
export async function sweepColdHolds(now = Date.now()): Promise<void> {
  if (lap) await lap.catch(() => {});
  lap = (async () => {
    const store = await readQueueFileFresh();
    const { waitsWhenCold } = await import('./wake-policy.js');
    let holding = 0;
    for (const [sid, rows] of Object.entries(store.queues)) {
      const held = rows.filter(isColdHold);
      if (held.length === 0) continue;
      holding++;
      try {
        const due = held.some((r) => coldHoldReleaseAt(r) <= now);
        if (due) await releaseAndSend(sid, 'the oldest held message reached its max hold');
        // Held under an older rule that no longer holds it (a restart onto a build where a task's
        // own trigger fire or wait clock goes at once, 2026-11-18): it goes now.
        else if (held.some((r) => !waitsWhenCold(r.message))) await releaseAndSend(sid, 'a held message no longer waits');
        else if (!(await sessionIsCold(sid, now))) await releaseAndSend(sid, 'the session is warm or running');
      } catch (err) {
        log.session.warn('cold hold: sweep failed for a session', { sessionId: sid, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (holding === 0 && sweep) { clearInterval(sweep); sweep = null; }
  })().finally(() => { lap = null; });
  return lap;
}

/** Sessions whose queue holds a cold-held row (a restart's leftovers). */
export async function sessionsWithColdHolds(): Promise<string[]> {
  const store = await readQueueFileFresh();
  return Object.entries(store.queues).filter(([, rows]) => rows.some(isColdHold)).map(([sid]) => sid);
}

/** Boot: a restart's held rows are looked at now and by the sweep; a row past its max hold goes at once. */
export async function startColdHold(): Promise<void> {
  if ((await sessionsWithColdHolds()).length === 0) return;
  armSweep();
  await sweepColdHolds();
}

/** Test seam. */
export function stopColdHold(): void {
  if (sweep) clearInterval(sweep);
  sweep = null;
}
