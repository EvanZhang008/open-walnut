/**
 * The gate on a Personal AI lane that is still busy with an earlier turn.
 *
 * A lane turn that stalls while its CLI keeps running is not over (lane-turn.ts):
 * the next turn on that lane must not send until it is, because a send into a
 * CLI that is mid-turn JOINS that turn. A mid-turn delivery does not start a new
 * turn generation, so the earlier turn's single result is then claimed as the
 * newcomer's answer and the newcomer's own answer is never read (the 2026-09-26
 * glued-answer bug, and gate finding N1 on 2026-09-30).
 *
 * The gate opens only when the earlier turn has provably ENDED: its result, the
 * lane record reading idle or gone, or the CLI's death. Giving up on the late
 * answer (a second full stall, or the 60-minute cap) is not an end, because the
 * CLI may still be in that turn. So a give-up with the CLI alive DRAINS the lane: it asks
 * the CLI to stop the turn (the same interrupt the Stop button sends) and keeps
 * the gate closed until the turn ends.
 *
 * Why interrupt instead of only waiting: every give-up is a CLI that is not
 * finishing (silent for two stall windows, or busy for an hour), so waiting alone
 * can last as long as the CLI stays wedged, while the user has already been told
 * the turn failed. Why not interrupt and send right away: the interrupt is
 * asynchronous, so a send before the turn has ended can still join it.
 *
 * A waiter never sends into a busy lane. If the lane has not ended its turn
 * within one window after the interrupt, the waiters of that window are answered
 * 'busy' (their turn fails with a plain error, nothing is sent) and the gate stays
 * closed for the next ones; the interrupt is sent again each window.
 */

import { bus, EventNames } from '../event-bus.js';
import { eventData } from '../event-types.js';
import { log } from '../../logging/index.js';

export type LaneGateVerdict = 'free' | 'busy';

interface Window {
  promise: Promise<LaneGateVerdict>;
  resolve: (v: LaneGateVerdict) => void;
}

/** sessionId → the window current waiters are waiting on. */
const gates = new Map<string, Window>();
/** Lanes being drained (a give-up with the CLI alive) → stop that drain's watch. */
const draining = new Map<string, () => void>();

function newWindow(): Window {
  let resolve!: (v: LaneGateVerdict) => void;
  const promise = new Promise<LaneGateVerdict>((r) => { resolve = r; });
  return { promise, resolve };
}

/** The window a new turn on this lane must wait on, or undefined when the lane is free. */
export function laneGate(sessionId: string): Promise<LaneGateVerdict> | undefined {
  return gates.get(sessionId)?.promise;
}

/** A turn on this lane stalled with its CLI still running: close the gate. */
export function closeLaneGate(sessionId: string): void {
  if (!gates.has(sessionId)) gates.set(sessionId, newWindow());
}

/** The earlier turn has ended: every waiter may send. */
export function openLaneGate(sessionId: string): void {
  const w = gates.get(sessionId);
  gates.delete(sessionId);
  const stop = draining.get(sessionId);
  draining.delete(sessionId);
  stop?.();
  w?.resolve('free');
}

/** Tests only. */
export function _closedLaneGatesForTesting(): string[] {
  return [...gates.keys()];
}

/** Tests only: forget every gate and stop every drain (waiters are left pending). */
export function _resetLaneGatesForTesting(): void {
  for (const stop of draining.values()) stop();
  draining.clear();
  gates.clear();
}

export interface LaneProcess {
  status: string | null;
  reason: string | null;
  /** 'missing': the read worked and there is no record; 'failed': it could not be read. */
  read: 'ok' | 'missing' | 'failed';
}

/** The lane's persisted process status. A failed read and a missing record differ. */
export async function readLaneProcess(sessionId: string): Promise<LaneProcess> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    if (!record) return { status: null, reason: null, read: 'missing' };
    return { status: record.process_status ?? null, reason: record.status_reason ?? null, read: 'ok' };
  } catch {
    return { status: null, reason: null, read: 'failed' };
  }
}

/**
 * Dead means the CLI is gone. A remote lane in a tunnel flap reads
 * 'error'/remote_unreachable: that is unknown liveness, not a death
 * (walnut-core-internals, Rule A guard).
 */
export function laneProcessDead(proc: Pick<LaneProcess, 'status' | 'reason'>): boolean {
  return (proc.status === 'stopped' || proc.status === 'error') && proc.reason !== 'remote_unreachable';
}

/**
 * The late watch gave up while the CLI may still be in the turn: interrupt it and
 * keep the gate closed until the turn ends (see the header).
 */
export function drainLaneGate(opts: {
  sessionId: string;
  agentId: string;
  conversationId: string;
  source: string;
  why: string;
  tickMs: number;
  /** How long one window of waiters waits before it is answered 'busy'. */
  windowMs: number;
}): void {
  const { sessionId: sid, agentId, conversationId, source, why } = opts;
  closeLaneGate(sid);
  if (draining.has(sid)) return;
  const subName = `lane-gate-drain-${sid}`;
  let windowStart = Date.now();
  let probing = false;
  let done = false;
  const stop = (): void => {
    done = true;
    bus.unsubscribe(subName);
    clearInterval(tick);
  };

  const interrupt = (): void => {
    bus.emit(EventNames.SESSION_INTERRUPT, { sessionId: sid }, ['session-runner'], { source: 'lane-turn-drain' });
  };
  const end = (how: string): void => {
    if (done) return;
    stop();
    log.session.info('lane gate: the earlier turn ended, the lane is free', {
      sessionId: sid, agentId, conversationId, source, how,
    });
    openLaneGate(sid);
  };

  bus.subscribe(subName, (event) => {
    if (done) return;
    const d = event.data as { sessionId?: string } | undefined;
    if (d?.sessionId !== sid) return;
    if (event.name === EventNames.SESSION_RESULT) {
      // A team still working has not ended its turn (the rule lane-turn.ts uses).
      if (eventData<'session:result'>(event).teamActive) return;
      end('result');
    } else if (event.name === EventNames.SESSION_ERROR) {
      // delivery_failed is connectivity, not a turn outcome (event-types.ts).
      if (eventData<'session:error'>(event).errorKind === 'delivery_failed') return;
      end('error');
    }
  }, { global: true, interest: [EventNames.SESSION_RESULT, EventNames.SESSION_ERROR] });

  const tick: ReturnType<typeof setInterval> = setInterval(() => {
    if (done || probing) return;
    probing = true;
    void readLaneProcess(sid).then((proc) => {
      if (done) return;
      if (laneProcessDead(proc)) { end(`process-${proc.status}`); return; }
      if (proc.status === 'idle') { end('idle'); return; }
      // The lane's record is gone (the session was deleted): it will never read
      // idle or dead, so a drain waiting on it would never end (gate finding
      // P3-R3-3). A read that FAILED proves nothing and keeps the drain going.
      if (proc.read === 'missing') { end('record-gone'); return; }
      if (Date.now() - windowStart < opts.windowMs) return;
      // The turn did not end within a window: answer this window's waiters
      // 'busy' (nothing is sent), keep the gate closed, and ask again.
      windowStart = Date.now();
      const w = gates.get(sid);
      gates.set(sid, newWindow());
      w?.resolve('busy');
      log.session.warn('lane gate: the earlier turn has not ended; waiting turns are refused, interrupting again', {
        sessionId: sid, agentId, conversationId, source, processStatus: proc.status,
      });
      interrupt();
    }).finally(() => { probing = false; });
  }, opts.tickMs);
  tick.unref?.();
  draining.set(sid, stop);

  log.session.warn('lane gate: giving up on a late answer while the CLI may still be in that turn; interrupting it', {
    sessionId: sid, agentId, conversationId, source, why,
  });
  interrupt();
}
