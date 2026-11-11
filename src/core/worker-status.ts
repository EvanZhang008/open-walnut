/**
 * The experiment `leader_status_follows_workers` (src/core/experimental.ts): a leader's status
 * reads from its open workers instead of its own session alone. 2026-11-11, the user: a leader
 * with five workers working read as finished ("it always shows completed, actually it's not
 * completed at all"); "its own task depends on its workers".
 *
 * Order, first match wins:
 *  1. Its own status stands when it has no workers, is Completed or snoozed, asks the user
 *     itself, answered the user's message (To read, `answer`), or holds a same-ask fold or an
 *     answer given above (same-ask.ts: `sameAsk`, `answeredFor`), whose memory lives on it.
 *  2. An ask of the user anywhere below (rolled up into `asks`, or a worker that needs the user):
 *     Needs you, the asks naming their owners.
 *  3. The leader itself, or any worker, is Working: Working.
 *  4. Every worker finished (Completed, or reported done for its lead to close): a leader with a
 *     lead of its own waits on that lead to check and close it, as a finished worker does; one
 *     with none reads To read (Can close). A leader still waiting on its own outside thing (its
 *     build, a deploy, a time) keeps that wait.
 *  5. A worker has a result to read: To read.
 *  6. Otherwise (every open worker waits or is snoozed): Waiting.
 * When the answer is the state the leader already reads, its own status stays as it is (its own
 * words are the more exact ones). Only the display changes: phases and worker rows are untouched,
 * and a routine run's self-close is judged on the leader's own status (user-status-sync.ts).
 */
import { LEAD_CLOSE_WAIT, type UserStatus, type WaitKind } from './user-status.js';

/** A wait of the leader's own that its workers finishing does not end. */
const OWN_WAITS: ReadonlySet<WaitKind> = new Set<WaitKind>(['outside', 'machine', 'own', 'time']);

const finished = (s: UserStatus): boolean => s.state === 'done' || (s.kind === 'lead' && s.waitingOn === LEAD_CLOSE_WAIT);

function ownStands(own: UserStatus, workers: readonly UserStatus[]): boolean {
  return !workers.length || own.state === 'done' || own.state === 'needs' || !!own.snoozed
    || (own.state === 'read' && own.toRead === 'answer') || !!own.sameAsk || !!own.answeredFor;
}

export function workerStatus(own: UserStatus, workers: readonly UserStatus[], opts: { hasLeader?: boolean } = {}): UserStatus {
  if (ownStands(own, workers)) return own;
  const keep = (next: UserStatus): UserStatus => (next.state === own.state && next.kind === own.kind ? own : next);
  // No `ask` of its own: the asks stay their owners' (`asks`), or the leader above would carry
  // each one twice (rollUpAsks reads a needs row's own ask too).
  if (own.asks?.length || workers.some((s) => !s.snoozed && s.state === 'needs')) {
    return keep({ ...words(own), state: 'needs' });
  }
  if (own.state === 'working') return own;
  const open = workers.filter((s) => !finished(s));
  if (open.some((s) => !s.snoozed && s.state === 'working')) {
    return keep({ ...words(own), state: 'working', waitingOn: 'Its workers are working' });
  }
  if (!open.length) {
    if (own.state === 'waiting' && own.kind && OWN_WAITS.has(own.kind)) return own;
    if (opts.hasLeader) return keep({ ...words(own), state: 'waiting', kind: 'lead', waitingOn: LEAD_CLOSE_WAIT });
    return keep({ ...words(own), state: 'read', toRead: 'result', category: 'close',
      waitingOn: 'Its workers have finished: check their results and close it' });
  }
  if (open.some((s) => s.state === 'read')) {
    return keep({ ...words(own), state: 'read', toRead: 'result', category: 'look', waitingOn: 'A worker has a result to read' });
  }
  return keep({ ...words(own), state: 'waiting', kind: 'task', waitingOn: 'Its open workers are waiting or snoozed' });
}

/** Keep context and rolled asks; drop the former state's reason, line and decision. */
function words(s: UserStatus): Pick<UserStatus, 'now' | 'next' | 'at' | 'reportBy' | 'reportSessionId' | 'asks' | 'threads' | 'due'> {
  const { now, next, at, reportBy, reportSessionId, asks, threads, due } = s;
  return Object.fromEntries(Object.entries({ now, next, at, reportBy, reportSessionId, asks, threads, due }).filter(([, v]) => v !== undefined));
}
