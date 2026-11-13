/**
 * A session about to end its turn while it holds a request it has not answered is told so,
 * before the turn closes, through the CLI's own Stop hook (src/providers/stop-unanswered-hook.ts).
 *
 * 2026-10-29, Main's reflection: two workers ended a turn with "No response requested" while
 * holding a request that waited for their reply, and a third ended mid-check with no answer.
 * The asker heard only an hour later, from the deadline notice. The Stop hook's `block`
 * answer makes the CLI go on in the SAME turn with the reason as its input, so the session
 * answers (or says why not) right away, and no new turn is spent.
 *
 * Counted: an open request to this session (or its task), pending or overdue, whose message
 * reached it (no queue row still waiting or parked for it), not handed on (`hands_on`: the work
 * moved, a reply comes from where it went), from an asker whose task is still open. Not nagged at
 * all, because its answer comes later and an early "where it stands" reply would settle the
 * request before the result: a turn whose own work runs on after it (a detached background
 * command, an armed wakeup: `workOutlivesTurn`), a task parked as WAITING, a session that itself
 * waits on an answer from another task. No loop: the hook passes nothing on a stop the
 * hook itself continued (`stop_hook_active`), so one nudge per turn, and a request is named in
 * at most MAX_NUDGES turns. Never throws: a reminder is best effort.
 */
import type { SessionRequest } from '../session-requests.js';

/** Turns one request is named in before Walnut stops naming it. */
export const MAX_NUDGES = 3;

/** How many turns each request was named in (this process; a restart starts over). */
const nudged = new Map<string, number>();

/** For tests. */
export function resetStopNudges(): void { nudged.clear(); }

/** The words the session reads before its turn closes. Pure. */
export function unansweredStopReason(
  open: readonly { request: SessionRequest; from: string }[],
  now = Date.now(),
): string {
  const ago = (iso: string) => {
    const mins = Math.max(1, Math.round((now - Date.parse(iso)) / 60_000));
    return mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  };
  const lines = open.map(({ request: r, from }) => `- ${r.id} from ${from}, asked ${ago(r.createdAt)}: "${r.preview}"`);
  // Several from one asker: one answer settles them, and the asker reads it once (2026-11-13: a
  // task answered its lead's three requests with three nearly identical replies in three seconds).
  const byAsker = new Map<string, { from: string; ids: string[] }>();
  for (const { request: r, from } of open) {
    const g = byAsker.get(r.fromSessionId) ?? { from, ids: [] };
    g.ids.push(r.id);
    byAsker.set(r.fromSessionId, g);
  }
  const shared = [...byAsker.values()].filter((g) => g.ids.length > 1);
  // One call takes at most 20 (MAX_ANSWERED_AT_ONCE): a bigger group answers in several.
  const firstIds = shared[0]?.ids.slice(0, 20) ?? [open[0]?.request.id ?? '<request id>'];
  const replyTo = firstIds.length > 1 ? `[${firstIds.map((id) => `"${id}"`).join(',')}]` : `"${firstIds[0]}"`;
  return [
    `Walnut: before this turn ends, you hold ${open.length === 1 ? 'a request' : `${open.length} requests`} that waits for your reply, still unanswered:`,
    ...lines,
    ...shared.map((g) => `${g.ids.length} of them are from ${g.from} (${g.ids.join(', ')}): answer them in ONE task_send with in_reply_to listing all of them, never one nearly identical reply each.`),
    `Answer ${firstIds.length > 1 ? 'them' : 'it'} now: mcp__walnut__task_send {"in_reply_to":${replyTo},"title":"<one line>","text":"<your result>"} (no such tool: walnut tools call task_send with that JSON).`,
    'Still working on it in a later turn: end this turn as you planned, and reply when the work is done (a reply settles the request, so do not send a progress note). '
      + 'Handed it to another task: name that request with hands_on on your ask to it. '
      + 'Needs no answer: reply in one line saying why, so the asker stops waiting.',
  ].join('\n');
}

/** The Stop hook's reason for `callerSid`, or null when nothing should hold the turn. */
export async function unansweredAtStop(callerSid: string | undefined, now = Date.now()): Promise<{ reason: string; requests: string[] } | null> {
  const sid = (callerSid ?? '').trim();
  if (!sid) return null;
  try {
    const { isCompanion } = await import('../server-role.js');
    if (isCompanion()) return null;
    const { resolveCaller } = await import('./session-send-core.js');
    const caller = await resolveCaller(sid).catch(() => null);
    if (caller?.kind !== 'session' || !caller.record.taskId) return null;
    const requests = await import('../session-requests.js');
    const taskId = caller.record.taskId;
    const rows = await requests.listAllSessionRequests().catch(() => [] as SessionRequest[]);
    const candidates = rows.filter((r) => (r.status === 'pending' || r.status === 'expired')
      // Addressed to another session of the task: this one never read it.
      && (r.toSessionId ? r.toSessionId === sid : r.toTaskId === taskId)
      && !r.carriedBy?.length && (nudged.get(r.id) ?? 0) < MAX_NUDGES);
    if (!candidates.length) return null;
    const { listTasksByIds } = await import('../task-manager.js');
    const own = (await listTasksByIds([taskId]).catch(() => []))[0];
    if (!own || own.phase === 'COMPLETE') return null;
    // Its answer comes later (its work runs on, it parked, it waits on another task): the same
    // facts the turn-end edge leaves a request open for (request-progress.ts).
    const { progressReason } = await import('./request-progress.js');
    if (await progressReason({ sessionId: sid, taskId, phase: own.phase, rows })) return null;

    const { undeliveredRowFor } = await import('./undelivered-requests.js');
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const open: { request: SessionRequest; from: string }[] = [];
    for (const r of candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)) {
      // Not read yet: still queued for this session, or parked. Its turn comes later.
      const row = await undeliveredRowFor(r.toSessionId ?? sid, r.id).catch(() => undefined);
      if (row && row.status !== 'processing') continue;
      const askerTaskId = (await getSessionByClaudeId(r.fromSessionId).catch(() => undefined))?.taskId;
      const asker = askerTaskId ? (await listTasksByIds([askerTaskId]).catch(() => []))[0] : undefined;
      if (asker?.phase === 'COMPLETE' || askerTaskId === taskId) continue;
      open.push({ request: r, from: asker ? `"${asker.title}" (${asker.id})` : 'another session' });
    }
    if (!open.length) return null;
    for (const { request } of open) nudged.set(request.id, (nudged.get(request.id) ?? 0) + 1);
    // A long-running server: forget the oldest names (a request named MAX_NUDGES times is old news).
    if (nudged.size > 2_000) for (const k of [...nudged.keys()].slice(0, 1_000)) nudged.delete(k);
    return { reason: unansweredStopReason(open, now), requests: open.map((o) => o.request.id) };
  } catch {
    return null;
  }
}
