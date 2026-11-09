/**
 * What a `task_start` refused with session_exists tells its caller to do instead: never a dead
 * end. 2026-11-08, Operations VP: a start a minute after a server outage answered session_exists,
 * so it sent its ask a second time, though the task already had the first one and was answering
 * it. The answer names the caller's own open request to that task, whether its session has it,
 * and that its reply comes on its own; with none, it says to send the work with task_send, which
 * reaches the session whether it runs a turn, waits or was stopped (Walnut resumes it).
 */
import { stillReached, type SessionRequest } from '../session-requests.js';

export interface SessionExistsHint {
  /** The words added to the refusal. */
  line: string;
  /** The caller's newest open request to that task, when it holds one. */
  openRequest?: { id: string; askedAt: string; reachedAt?: string };
}

/** Pure: the hint for a caller holding these open requests to the task. */
export function sessionExistsHintFor(taskId: string, open: readonly SessionRequest[], takenBack?: ReadonlySet<string>): SessionExistsHint {
  const mine = [...open].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!mine) {
    return {
      line: `Send the work with task_send {"to":"${taskId}","text":"..."}: it reaches the task's session whether it is in a turn, idle or stopped (Walnut resumes a stopped one).`,
    };
  }
  const reached = stillReached(mine, takenBack);
  const has = reached
    ? `its session has had it since ${mine.reachedAt}`
    : 'it is queued for its session, which takes it next (Walnut resumes a stopped one)';
  return {
    line: `It already has your request ${mine.id} (asked ${mine.createdAt}): ${has}. Its answer comes back to you on its own, so do not send it again;`
      + ` to add to it, task_send {"to":"${taskId}","text":"..."}.`,
    openRequest: { id: mine.id, askedAt: mine.createdAt, ...(reached ? { reachedAt: mine.reachedAt } : {}) },
  };
}

/** The hint for this caller (its session id) and task. Never throws: the plain send line when the ledger cannot be read. */
export async function sessionExistsHint(taskId: string, callerSid: string | undefined): Promise<SessionExistsHint> {
  let open: SessionRequest[] = [];
  let takenBack: Set<string> | undefined;
  if (callerSid) {
    try {
      const { pendingRequestsForTarget } = await import('../session-requests.js');
      open = (await pendingRequestsForTarget({ taskId })).filter((r) => r.fromSessionId === callerSid);
      const { takenBackIds } = await import('./request-reached.js');
      takenBack = await takenBackIds(open.map((r) => r.toSessionId ?? ''));
    } catch { /* the plain line */ }
  }
  return sessionExistsHintFor(taskId, open, takenBack);
}
