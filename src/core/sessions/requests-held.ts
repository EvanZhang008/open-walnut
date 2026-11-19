/**
 * The requests a task still holds: someone asked it and waits for its answer. ONE rule, read by
 * every place that asks "does this task still owe a reply" (2026-11-18, the Walnut VP: a lead's
 * request reached a task's session 2 s before that session closed its own task, unread; the task
 * stayed COMPLETE while it went on with the next stage, and nothing reopened it):
 *
 * - the Stop hook naming what a turn leaves unanswered (unanswered-at-stop.ts),
 * - a task's own close (admitHeldRequests, called by admitSessionClose in owed-to-user.ts),
 * - another session closing it (complete-in-use.ts unfinishedWork).
 *
 * Held: a request pending or overdue (an overdue one stays open until a reply, OVERDUE_OPEN_MS),
 * addressed to the task or to one of its sessions, not handed on (`hands_on` while the task it went
 * to still works on it: a reply comes from there; one that came back is owed again), from an asker
 * that is not this task, whose task is still open (a closed asker reads no answer) and that a reply
 * can still reach (reply-routing.ts: an asker whose sessions are all gone cannot be answered, so it
 * never holds anything). Whether its message is still queued for the session (not read yet) is
 * reported, never a reason to skip it: a close drops a queued request as surely as a read one.
 */
import { carriedState, type SessionRequest } from '../session-requests.js';

export interface HeldRequest {
  request: SessionRequest;
  /** The asker as a reader names it: `"<title>" (<id>)`, or "another session". */
  from: string;
  /** Its message still waits in the session's queue (or is parked): the session has not read it. */
  queued: boolean;
}

export interface HeldScope {
  taskId: string;
  /** 'session': only what reached this session (a request to another session of the task is that
   *  session's to answer). 'task': anything to the task or to any of `sessionIds`. */
  reach: { kind: 'session'; sessionId: string } | { kind: 'task'; sessionIds: readonly string[] };
  /** Rows already read by the caller (one ledger read per check). */
  rows?: readonly SessionRequest[];
  /** An asker whose own requests do not count (a closer's asks are its own to drop). */
  exceptFromSessionId?: string;
  /** Rows that never count (they still count as the ledger a hand-off is read from). */
  skip?: (r: SessionRequest) => boolean;
  /** Most rows resolved (newest first); the rest are not named. */
  limit?: number;
  now?: number;
}

/** Whether `r` is still open and addressed within `scope`. Pure; `rows` is the whole ledger. */
export function heldBy(r: SessionRequest, scope: HeldScope, now: number, overdueOpenMs: number, rows: readonly SessionRequest[]): boolean {
  const open = r.status === 'pending' || (r.status === 'expired' && now - Date.parse(r.createdAt) <= overdueOpenMs);
  if (!open || carriedState(r, rows) === 'out') return false;
  if (scope.exceptFromSessionId && r.fromSessionId === scope.exceptFromSessionId) return false;
  const { reach, taskId } = scope;
  return reach.kind === 'session'
    // Addressed to another session of the task: this one never read it.
    ? (r.toSessionId ? r.toSessionId === reach.sessionId : r.toTaskId === taskId)
    : r.toTaskId === taskId || (!!r.toSessionId && reach.sessionIds.includes(r.toSessionId));
}

/** The requests `scope` holds, newest first. Throws only when the ledger cannot be read. */
export async function requestsHeld(scope: HeldScope): Promise<HeldRequest[]> {
  const requests = await import('../session-requests.js');
  const now = scope.now ?? Date.now();
  const rows = scope.rows ?? await requests.listAllSessionRequests();
  const candidates = rows.filter((r) => !scope.skip?.(r) && heldBy(r, scope, now, requests.OVERDUE_OPEN_MS, rows))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!candidates.length) return [];
  const limit = scope.limit ?? 20;
  const { undeliveredRowFor } = await import('./undelivered-requests.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const { listTasksByIds } = await import('../task-manager.js');
  const { resolveReplyDestination } = await import('./reply-routing.js');
  const out: HeldRequest[] = [];
  // Filtered first, then cut: a newer row that does not count never hides an older one that does.
  for (const r of candidates) {
    if (out.length >= limit) break;
    const askerTaskId = (await getSessionByClaudeId(r.fromSessionId).catch(() => undefined))?.taskId;
    if (askerTaskId === scope.taskId) continue;
    const asker = askerTaskId ? (await listTasksByIds([askerTaskId]).catch(() => []))[0] : undefined;
    if (asker?.phase === 'COMPLETE') continue;
    // Nobody to answer: a reply would be refused (origin_session_gone), so it holds nothing.
    if (!await resolveReplyDestination(r.fromSessionId).catch(() => null)) continue;
    const to = r.toSessionId ?? (scope.reach.kind === 'session' ? scope.reach.sessionId : scope.reach.sessionIds[0]);
    const row = await undeliveredRowFor(to, r.id).catch(() => undefined);
    out.push({ request: r, from: asker ? `"${asker.title}" (${asker.id})` : 'another session', queued: !!row && row.status !== 'processing' });
  }
  return out;
}

/** The ask a task start sent as a session's first message (task-start.ts). A row from before
 *  `opensSession` was stored has no queue row of its own (`messageId`, which every send carries). */
export function opensSession(r: SessionRequest): boolean {
  return r.opensSession === true || !r.messageId;
}

/** The answer a task's own close gets while it holds a request (admitSessionClose). */
export interface HeldRequestRefusal {
  ok: false;
  code: 'unanswered_request';
  message: string;
  items: Array<{ source: 'request'; id: string; text: string }>;
}

/**
 * A session closing its OWN task while the task holds a request: refused, naming each one. Refusing
 * beats closing and reopening: the closing session is mid-turn, so it reads the request now and
 * answers it in the same turn, and the task never shows COMPLETE while its work goes on. No force:
 * a one-line reply (or `hands_on` to the task that took it) settles a request, so nothing is stuck.
 * A ledger that cannot be read never blocks a close.
 */
export async function admitHeldRequests(
  task: { id: string; session_id?: string },
  closerSid: string | undefined,
  now = Date.now(),
): Promise<HeldRequestRefusal | null> {
  let held: HeldRequest[];
  try {
    const sessionIds = [...new Set([closerSid, task.session_id].filter((s): s is string => !!s))];
    // The ask that started a session is the task's brief: its close hands the result to that asker
    // (session-request-notify.ts), so only a request that came in on top of it holds the close.
    held = await requestsHeld({ taskId: task.id, reach: { kind: 'task', sessionIds }, skip: opensSession, now, limit: 10 });
  } catch {
    return null;
  }
  if (!held.length) return null;
  const ago = (iso: string) => {
    const secs = Math.max(1, Math.round((now - Date.parse(iso)) / 1000));
    return secs < 120 ? `${secs} s ago` : secs < 5400 ? `${Math.round(secs / 60)} min ago` : `${Math.round(secs / 3600)} h ago`;
  };
  const lines = held.map(({ request: r, from, queued }) =>
    `- ${r.id} from ${from}, sent ${ago(r.createdAt)}${queued ? ' (not read yet: it is still queued for your session)' : ''}: "${r.preview}"`);
  // One answer per asker (one-answer-per-asker.test.ts): several from one asker settle in one call.
  const byAsker = new Map<string, { from: string; ids: string[] }>();
  for (const { request: r, from } of held) {
    const g = byAsker.get(r.fromSessionId) ?? { from, ids: [] };
    g.ids.push(r.id);
    byAsker.set(r.fromSessionId, g);
  }
  const answer = (ids: string[]) => {
    const list = ids.slice(0, 20);
    return `task_send {"in_reply_to":${list.length > 1 ? `[${list.map((id) => `"${id}"`).join(',')}]` : `"${list[0]}"`},"title":"<one line>","text":"<your result>"}`;
  };
  const groups = [...byAsker.values()];
  const message = [
    `Not closed: this task holds ${held.length === 1 ? 'a request' : `${held.length} requests`} not answered yet, and closing would leave the asker waiting on a task that reads COMPLETE:`,
    ...lines,
    `Read it in full (request_get {"id":"${held[0].request.id}"}), then do what it asks and answer it: `
      + (groups.length === 1 ? answer(groups[0].ids) : groups.map((g) => `for ${g.from}, ONE ${answer(g.ids)}`).join('; ')) + '.',
    'If it needs no answer or your result already answers it, reply in one line saying so; if another task took the work, name it there with hands_on. Then close again.',
  ].join('\n');
  return { ok: false, code: 'unanswered_request', message, items: held.map(({ request: r }) => ({ source: 'request', id: r.id, text: r.preview })) };
}
