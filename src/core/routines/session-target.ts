/**
 * Which recorded session on a task should receive an automated message.
 *
 * Two outcome paths (walnut-trigger's `session` executor and the watcher's
 * singleton) answer the same question, so the rule lives once, as a pure
 * function over the records they already hold.
 *
 * A session whose CLI is alive (running/idle) is the first choice: the FIFO
 * delivers into the open turn. A STOPPED session is the second, not a miss: the
 * idle reaper kills the CLI after a couple of quiet hours and the record reads
 * 'stopped', but the transcript is intact and a send cold-resumes it with
 * `--resume`, which is exactly how the user keeps chatting in that panel after a
 * long pause. Treating 'stopped' as dead was the difference between "the
 * conversation that set up this trigger hears the result" and "a fresh session
 * with no memory of why it is being told", because a trigger typically fires
 * hours after the session that created it went quiet.
 *
 * An 'error' the INFRASTRUCTURE caused (host rebooted or unreachable, daemon lost
 * the process) is resumable the same way, on a host the caller knows is up: the
 * transcript is on that host's disk, which is what session-auto-recover relies
 * on. For a trigger it is the common case, not an edge: an outage is what piles
 * fires up, the fires are replayed the moment the host is back, and the session
 * the outage killed still reads 'error' then. A fire is itself the proof that its
 * host is reachable, so the trigger passes that host. Without one (or on another
 * host) such a session is skipped, since a send would only queue behind a resume
 * that cannot happen. Any other 'error' is terminal (isTerminalSession), and an
 * archived session is never a target. Among equals, the most recently active.
 * Returns null when the task has no resumable session and the caller must start
 * a new one.
 */

import { isInfraSessionError } from '../session-error-kind.js';
import type { SessionErrorKind, StatusReason } from '../types.js';

export interface DeliverySessionCandidate {
  process_status?: string;
  archived?: boolean;
  lastActiveAt?: string;
  status_reason?: StatusReason;
  errorKind?: SessionErrorKind;
  errorMessage?: string;
  host?: string;
}

export interface DeliveryPickOptions {
  /** A host known to be reachable right now (the one whose daemon sent the fire). */
  reachableHost?: string;
}

function sameHost(a: string | undefined, b: string | undefined): boolean {
  return (a || '__local__') === (b || '__local__');
}

/** True when the CLI behind the record is alive, so a send lands without a cold resume. */
export function isLiveSessionStatus(status: string | undefined): boolean {
  return status === 'running' || status === 'idle';
}

function tierOf(session: DeliverySessionCandidate, opts: DeliveryPickOptions): number | null {
  if (isLiveSessionStatus(session.process_status)) return 0;
  if (session.process_status === 'stopped') return 1;
  if (session.process_status === 'error' && opts.reachableHost !== undefined
    && sameHost(session.host, opts.reachableHost) && isInfraSessionError(session)) return 1;
  return null;
}

/** True when `a` was active more recently than `b`; ties and missing stamps keep the earlier row. */
function newer(a: DeliverySessionCandidate, b: DeliverySessionCandidate): boolean {
  const ta = Date.parse(a.lastActiveAt ?? '');
  const tb = Date.parse(b.lastActiveAt ?? '');
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta > tb;
}

export function pickDeliverySession<S extends DeliverySessionCandidate>(sessions: S[], opts: DeliveryPickOptions = {}): S | null {
  let best: S | null = null;
  let bestTier = Number.POSITIVE_INFINITY;
  for (const session of sessions) {
    if (session.archived) continue;
    const tier = tierOf(session, opts);
    if (tier === null) continue;
    if (tier < bestTier || (tier === bestTier && best && newer(session, best))) {
      best = session;
      bestTier = tier;
    }
  }
  return best;
}
