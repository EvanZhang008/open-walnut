/**
 * The session a switch or a move replaces, judged and ended by the daemon that owns its
 * CLI, never by its record (2026-11-08: a deploy restarted the Mac's daemon, the server
 * read the restarting daemon's error answer as the CLI's death and wrote the session
 * `stopped`; the new daemon adopted the live CLI, mid-turn. Hours later a move trusted
 * that record twice: it did not wait for the turn, and it sent no stop, because the
 * record said there was nothing to stop. The old CLI worked on beside the new session,
 * judged the new session's folder a leftover of the move and removed it).
 *
 * Two rules, both read from the owner:
 *  - ownerView: is the old CLI alive, and is it in a turn, between turns with work its
 *    turn left running, or idle. A switch or move waits on that, not on the record.
 *  - endReplacedSession: the old session is always stopped through its owner, whatever
 *    its record says, and the new session starts only once that stop is confirmed (or
 *    its host is lost, host-lost.ts: the stop then waits for the host, which ends the
 *    CLI before anything else when it returns). A stop the owner did not confirm while
 *    the CLI still runs refuses the switch: the task stays on the old session.
 * tests/core/sessions/replaced-session-guard.test.ts fails on a path that replaces a
 * task's session without going through endReplacedSession.
 */
import { log } from '../../logging/index.js';
import type { SessionRecord } from '../types.js';

export type OwnerHold = 'turn' | 'background' | 'idle';

export interface OwnerView {
  /** The owner has the CLI and its process runs. */
  alive: boolean;
  /** What it is doing: in a turn (or a prompt waits on the person), between turns with work its turn left running, or idle. */
  hold: OwnerHold;
}

const OWNER_VIEW_TIMEOUT_MS = 3_000;

type Rec = Pick<SessionRecord, 'claudeSessionId' | 'host' | 'engine'>;

/** Tests: answer for the owner. */
let viewOverride: ((rec: Rec) => Promise<OwnerView | null>) | null = null;
export function __setOwnerViewForTesting(fn: ((rec: Rec) => Promise<OwnerView | null>) | null): void {
  viewOverride = fn;
}

/**
 * The owning daemon's view of a session's CLI, or null when there is no answer (no link,
 * an error reply, a timeout, an ACP engine whose worker is asked another way). An answer
 * that the daemon does not hold the session reads not alive.
 */
export async function ownerView(rec: Rec): Promise<OwnerView | null> {
  if (viewOverride) return viewOverride(rec);
  const { isAcpEngine } = await import('../agents/engine-registry.js');
  if (isAcpEngine(rec.engine)) return null;
  const host = rec.host ?? '__local__';
  try {
    const { getPooledSnapshotConnection, probeDaemonSession } = await import('../../providers/daemon-connection.js');
    const conn = getPooledSnapshotConnection(host);
    if (conn) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        conn.send('getState', { sid: rec.claudeSessionId, memoryOnly: true }, OWNER_VIEW_TIMEOUT_MS).catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), OWNER_VIEW_TIMEOUT_MS); timer.unref?.(); }),
      ]).finally(() => clearTimeout(timer)) as {
        ok?: boolean; exists?: boolean; alive?: boolean;
        snapshot?: { cliState?: string; detachedBgCount?: number; wakeupAt?: number };
      } | null;
      // An error answer (a daemon shutting down) is no answer, never a death.
      if (!r || r.ok !== true) return null;
      if (r.exists !== true || r.alive !== true) return { alive: false, hold: 'idle' };
      const snap = r.snapshot;
      if (snap?.cliState === 'dead') return { alive: false, hold: 'idle' };
      if (snap?.cliState === 'running' || snap?.cliState === 'waiting') return { alive: true, hold: 'turn' };
      const { isWakeupArmed } = await import('../../providers/daemon-fold.js');
      if ((snap?.detachedBgCount ?? 0) > 0 || isWakeupArmed(snap?.wakeupAt)) return { alive: true, hold: 'background' };
      return { alive: true, hold: 'idle' };
    }
    // A daemon without snapshots answers liveness only: the stop that follows ends it either way.
    const probe = await probeDaemonSession(host, rec.claudeSessionId);
    return probe ? { alive: probe.alive, hold: 'idle' } : null;
  } catch {
    return null;
  }
}

export class ReplacedSessionLiveError extends Error {
  readonly status = 409;
  readonly code = 'old_session_live';
  constructor(message: string) {
    super(message);
    this.name = 'ReplacedSessionLiveError';
  }
}

/**
 * Stop the session a switch or a move replaces, through its owner, whatever its record says,
 * and return only once it is stopped (confirmed, its host lost, or the owner says no CLI of it
 * runs). Throws ReplacedSessionLiveError when its CLI still runs: the new session must not start.
 */
export async function endReplacedSession(rec: Rec, opts: { by?: string; taskId?: string } = {}): Promise<{ confirmed: boolean; hostLost?: boolean }> {
  const sid = rec.claudeSessionId;
  const host = rec.host ?? '__local__';
  let why = '';
  let stopId: string | undefined;
  try {
    const { terminateSession } = await import('./session-lifecycle.js');
    const res = await terminateSession(sid, { force: true, ...(opts.by ? { by: opts.by } : {}) });
    if (res?.status === 'terminated') return { confirmed: true, ...(res.hostLost ? { hostLost: true } : {}) };
    stopId = res?.stopRequest?.state === 'pending' ? res.stopRequest.id : undefined;
    why = 'its host did not confirm the stop yet';
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  // Not confirmed: the owner decides whether a CLI of it still runs.
  const view = await ownerView(rec);
  if (view && !view.alive) {
    log.session.info('replaced session: the stop was not confirmed, but its owner runs no CLI of it', { sessionId: sid, taskId: opts.taskId, host, why });
    return { confirmed: false };
  }
  // The task stays on this session: the stop asked for the switch is withdrawn, so its tries
  // do not end the session later and its fence does not hold the task's next messages.
  if (stopId) {
    const { sessionStops } = await import('./session-stop.js');
    await sessionStops.withdraw(sid, stopId, 'the switch or move it was for did not go ahead').catch(() => false);
  }
  log.session.warn('replaced session: its CLI may still run; the new session does not start', { sessionId: sid, taskId: opts.taskId, host, why, ownerAnswered: !!view });
  const where = host === '__local__' ? 'this Mac' : host;
  throw new ReplacedSessionLiveError(`The task's current session on ${where} could not be stopped (${why}), and its process ${view ? 'still runs' : 'may still run (its host did not answer)'}, so no second session was started and the task stays on it. Stop that session, then try again.`);
}
