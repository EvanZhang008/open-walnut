/**
 * Where a reply (or Walnut's no-reply notice) for a pending request must LAND.
 *
 * A request row records the session id that registered it, and for a long time
 * that id was also the delivery address. It is not the same thing: the asker is
 * a PERSON's train of thought, and that thought outlives one CLI process. The
 * 2026-09-11 incident is the shape of the gap — `rq-8e37b02f` was registered by
 * `c6ce9199`, the human forked that session minutes later and kept working in
 * the fork (a NEW task), the answer arrived six minutes after that and was
 * delivered into `c6ce9199`, which nobody was reading. The reply was not lost;
 * it was filed where the conversation no longer was.
 *
 * So the address is resolved, not read. In order, and deliberately additive —
 * the first rung is the common case and returns the registering session
 * untouched:
 *  ① the registering session, when it is still live (running/idle) and not
 *     archived. No re-route, no log line, no behavior change.
 *  ② the requester TASK's CURRENT session — exactly the rule `session_send`
 *     documents for a task handle ("a task id routes to the task's current
 *     session; an older/archived session of the same task is skipped").
 *  ③ the newest LIVE session FORKED from the registering one (`forkedFromSessionId`,
 *     walked transitively). A fork carries the parent's whole conversation, so it
 *     is the one process that can act on the answer; it usually has its own task,
 *     which is why rung ② cannot find it.
 *  ④ the registering session anyway, when it still exists and is not archived —
 *     today's behavior, so a stopped-but-resumable asker keeps working exactly
 *     as before.
 * Null = nowhere to deliver; callers keep their existing "asker is gone" answer.
 *
 * Only LISTABLE sessions are candidates (`isListableSession`): a lane-bound row
 * backs a UI surface rather than a session a person reads, and an environment row
 * (triage/hook/cron) can share a task id with the real one — routing a reply into
 * either would file it somewhere nobody looks. One predicate, the same one every
 * session list and send-target resolver uses.
 */

import { log } from '../../logging/index.js';
import type { SessionRecord } from '../types.js';

/** Statuses that can act on a message NOW (vs. stopped/error, which need a resume). */
const LIVE_STATUSES = new Set(['running', 'idle']);

export type ReplyRerouteReason = 'task-current-session' | 'live-fork';

export interface ReplyDestination {
  session: SessionRecord;
  /** Absent = the registering session itself (rungs ① and ④): nothing re-routed. */
  reason?: ReplyRerouteReason;
}

function isLive(s: SessionRecord): boolean {
  return LIVE_STATUSES.has(s.process_status);
}

/** Deliverable at all: a real session row a person could be reading. */
function addressable(
  s: SessionRecord,
  isListableSession: (r: SessionRecord) => boolean,
): boolean {
  return !s.archived && isListableSession(s);
}

/** Newest-active first, and a LIVE row always beats a terminal one. */
function bestFirst(a: SessionRecord, b: SessionRecord): number {
  if (isLive(a) !== isLive(b)) return isLive(a) ? -1 : 1;
  return (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '');
}

/**
 * Every session descended from `rootSid` through `forkedFromSessionId`, at any
 * depth. Built from ONE registry read (a parent→children index), so a long fork
 * chain costs no extra queries. `visited` also makes a corrupt cycle finite.
 */
function forkDescendants(all: SessionRecord[], rootSid: string): SessionRecord[] {
  const children = new Map<string, SessionRecord[]>();
  for (const s of all) {
    const parent = s.forkedFromSessionId;
    if (!parent || parent === s.claudeSessionId) continue;
    const bucket = children.get(parent);
    if (bucket) bucket.push(s);
    else children.set(parent, [s]);
  }
  const out: SessionRecord[] = [];
  const visited = new Set<string>([rootSid]);
  let frontier = [rootSid];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sid of frontier) {
      for (const child of children.get(sid) ?? []) {
        if (visited.has(child.claudeSessionId)) continue;
        visited.add(child.claudeSessionId);
        out.push(child);
        next.push(child.claudeSessionId);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Resolve the delivery address for a request registered by `fromSessionId`.
 * `exclude` keeps a destination out of the running — the replier's own session,
 * so answering a request can never route the answer back into the replier.
 */
export async function resolveReplyDestination(
  fromSessionId: string,
  opts?: { exclude?: Iterable<string> },
): Promise<ReplyDestination | null> {
  const excluded = new Set(opts?.exclude ?? []);
  const { getSessionByClaudeId, getSessionsForTask, listSessions, isListableSession } =
    await import('../session-tracker.js');
  const deliverable = (s: SessionRecord) => addressable(s, isListableSession);

  let origin: SessionRecord | null = null;
  try {
    origin = await getSessionByClaudeId(fromSessionId);
  } catch (err) {
    log.session.warn('reply routing: asker lookup failed', {
      fromSessionId, error: err instanceof Error ? err.message : String(err),
    });
  }

  // ① The common case: the asker is still there. Nothing below runs.
  if (origin && deliverable(origin) && isLive(origin) && !excluded.has(fromSessionId)) {
    return { session: origin };
  }

  // ② The requester TASK's current session (same rule a task handle follows).
  //
  // Rungs ② and ③ are each wrapped: a lookup that fails must degrade to rung ④
  // (the address on the row), never lose the delivery. This function is on the
  // path of BOTH the real reply and Walnut's fallback notice.
  const taskId = origin?.taskId?.trim();
  if (taskId) {
    try {
      const rows = (await getSessionsForTask(taskId))
        .filter((s) => deliverable(s)
          && s.claudeSessionId !== fromSessionId
          && !excluded.has(s.claudeSessionId));
      const pick = rows.sort(bestFirst)[0];
      // Only a session that can act NOW is worth re-routing to: a second stopped
      // row of the same task is no better an address than the original, and
      // reviving the WRONG dead process is worse than reviving the asker itself.
      if (pick && isLive(pick)) return { session: pick, reason: 'task-current-session' };
    } catch (err) {
      log.session.warn('reply routing: task session lookup failed', {
        fromSessionId, taskId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ③ A live fork of the asker — the process that inherited the conversation.
  try {
    const descendants = forkDescendants(await listSessions(), fromSessionId)
      .filter((s) => deliverable(s) && isLive(s) && !excluded.has(s.claudeSessionId));
    const fork = descendants.sort(bestFirst)[0];
    if (fork) return { session: fork, reason: 'live-fork' };
  } catch (err) {
    log.session.warn('reply routing: fork lineage lookup failed', {
      fromSessionId, error: err instanceof Error ? err.message : String(err),
    });
  }

  // ④ Nothing better exists — keep today's behavior.
  if (origin && !origin.archived && !excluded.has(fromSessionId)) return { session: origin };
  return null;
}

/** One line whenever the address is NOT the session that registered the request. */
export function logReplyReroute(
  requestId: string,
  fromSessionId: string,
  destination: ReplyDestination,
): void {
  if (!destination.reason) return;
  log.session.info('reply re-routed', {
    requestId,
    from: fromSessionId,
    to: destination.session.claudeSessionId,
    reason: destination.reason,
  });
}
