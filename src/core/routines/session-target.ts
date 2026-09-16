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
 * 'error' is terminal here as everywhere else (isTerminalSession), and an
 * archived session is never a target. Among equals, the most recently active.
 * Returns null when the task has no resumable session and the caller must start
 * a new one on the task.
 */

export interface DeliverySessionCandidate {
  process_status?: string;
  archived?: boolean;
  lastActiveAt?: string;
}

/** True when the CLI behind the record is alive, so a send lands without a cold resume. */
export function isLiveSessionStatus(status: string | undefined): boolean {
  return status === 'running' || status === 'idle';
}

function tierOf(status: string | undefined): number | null {
  if (isLiveSessionStatus(status)) return 0;
  if (status === 'stopped') return 1;
  return null;
}

/** True when `a` was active more recently than `b`; ties and missing stamps keep the earlier row. */
function newer(a: DeliverySessionCandidate, b: DeliverySessionCandidate): boolean {
  const ta = Date.parse(a.lastActiveAt ?? '');
  const tb = Date.parse(b.lastActiveAt ?? '');
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta > tb;
}

export function pickDeliverySession<S extends DeliverySessionCandidate>(sessions: S[]): S | null {
  let best: S | null = null;
  let bestTier = Number.POSITIVE_INFINITY;
  for (const session of sessions) {
    if (session.archived) continue;
    const tier = tierOf(session.process_status);
    if (tier === null) continue;
    if (tier < bestTier || (tier === bestTier && best && newer(session, best))) {
      best = session;
      bestTier = tier;
    }
  }
  return best;
}
