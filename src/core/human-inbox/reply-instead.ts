/**
 * A task answering another task's request reports to that task, not to the user's inbox.
 *
 * 2026-10-29 (the 12-hour org reflection): three finished pieces of work reached the user twice,
 * a worker's letter and Main's chat a minute apart (a daemon timeout fix, a highlight fix, the
 * status push). The asker already tells the user; the letter only doubles it. So a report letter
 * (`info`, `completion`, `review`) from a task that holds a request from another task (open, or
 * answered in the last ANSWERED_RECENTLY_MS) is refused with the request named, unless the session
 * says the user themself asked this task for a letter or a report (`userAsked`). A decision letter
 * (`action_required`) still goes: the task is blocked on the user, which is what the inbox is for.
 * Only an asker that reports to the user for this task counts: Main, the lead of the sender's
 * project, or a task above the sender (its leader's chain); a worker's question to its lead never
 * silences the lead, nor one lead's question another lead's. An open
 * request counts for OPEN_REQUEST_MS from when it was asked. Main's own letters and a pinned one (a
 * standing report the user set up) are never refused.
 *
 * Pure decision (`replyInsteadOf`) plus one read of the request ledger; never throws, so a ledger
 * that cannot be read costs nothing but the check.
 */
import type { SessionRequest } from '../session-requests.js';
import type { LetterSender, LetterType } from './types.js';

/** A request answered this recently still owns the result: the asker is telling the user now. */
export const ANSWERED_RECENTLY_MS = 6 * 60 * 60_000;
/** An open request older than this no longer speaks for the letter. */
export const OPEN_REQUEST_MS = 24 * 60 * 60_000;

const REPORT_TYPES: ReadonlySet<LetterType> = new Set(['info', 'completion', 'review']);

export interface AskingTask { requestId: string; taskId: string; title?: string; status: SessionRequest['status'] }

/**
 * The request that makes this letter a duplicate, or null. `askerTask` maps an asking session to its
 * task when that task counts (Main, a lead, a task above the sender); undefined never counts.
 */
export function replyInsteadOf(
  input: { type: LetterType; senderTaskId?: string; senderSessionId?: string },
  requests: readonly SessionRequest[],
  askerTask: (sessionId: string) => string | undefined,
  nowMs: number,
): { request: SessionRequest; askerTaskId: string } | null {
  if (!REPORT_TYPES.has(input.type) || !input.senderTaskId) return null;
  const mine = requests
    .filter((r) => r.toTaskId === input.senderTaskId || (!!input.senderSessionId && r.toSessionId === input.senderSessionId))
    .filter((r) => {
      if (r.status === 'pending' || r.status === 'expired') {
        const asked = Date.parse(r.createdAt);
        return Number.isFinite(asked) && nowMs - asked <= OPEN_REQUEST_MS;
      }
      if (r.status !== 'replied' && r.status !== 'notified') return false;
      const at = Date.parse(r.settledAt ?? '');
      return Number.isFinite(at) && nowMs - at <= ANSWERED_RECENTLY_MS;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const r of mine) {
    const asker = askerTask(r.fromSessionId);
    if (asker && asker !== input.senderTaskId) return { request: r, askerTaskId: asker };
  }
  return null;
}

/** The words of the refusal: which task asked, and what to do instead. */
export function replyInsteadMessage(hit: AskingTask): string {
  const who = `"${hit.title ?? hit.taskId}" (${hit.taskId})`
  const answered = hit.status === 'replied' || hit.status === 'notified'
  return `Not sent: ${who} asked this task for this work (request ${hit.requestId}), and it tells the user. `
    + (answered
      ? 'Your result already went to it; '
      : `Send your result in your reply to it (task_send with in_reply_to "${hit.requestId}"); `)
    + 'a letter would give the user the same news twice. Letter the user only when the user themself asked '
    + 'this task for a letter or a report: then send again with user_asked:true.';
}

/** The request this letter would duplicate, read from the ledger. Null when none (or on any error). */
export async function findReplyInstead(
  type: LetterType,
  sender: LetterSender,
  nowMs = Date.now(),
  opts: { pinned?: boolean } = {},
): Promise<AskingTask | null> {
  if (!REPORT_TYPES.has(type) || !sender.taskId || sender.pluginId || opts.pinned) return null;
  try {
    const { listAllSessionRequests } = await import('../session-requests.js');
    const rows = await listAllSessionRequests();
    const candidates = rows.filter((r) => r.toTaskId === sender.taskId || r.toSessionId === sender.sessionId);
    if (!candidates.length) return null;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const askers = new Map<string, string | undefined>();
    for (const r of candidates) {
      if (!askers.has(r.fromSessionId)) askers.set(r.fromSessionId, (await getSessionByClaudeId(r.fromSessionId).catch(() => undefined))?.taskId);
    }
    const { listTasksByIds } = await import('../task-manager.js');
    // The sender's leader chain (a subtask sits at most a few levels deep).
    const above = new Set<string>();
    let cursor = (await listTasksByIds([sender.taskId]).catch(() => []))[0];
    if (cursor?.org_role === 'main') return null;
    const project = cursor?.project ?? sender.project;
    for (let i = 0; i < 6 && cursor?.parent_task_id && !above.has(cursor.parent_task_id); i++) {
      above.add(cursor.parent_task_id);
      cursor = (await listTasksByIds([cursor.parent_task_id]).catch(() => []))[0];
    }
    const ids = [...new Set([...askers.values()].filter((id): id is string => !!id))];
    const tasks = new Map((await listTasksByIds(ids).catch(() => [])).map((t) => [t.id, t]));
    // A completed asker waits for nothing: its request was withdrawn with it. Only an asker that
    // reports to the user for this work counts.
    const live = (sid: string) => {
      const id = askers.get(sid);
      const t = id ? tasks.get(id) : undefined;
      if (!id || !t || t.phase === 'COMPLETE') return undefined;
      // Main, the sender's own lead (its project's), or a task above it.
      const ownLead = t.org_role === 'lead' && !!project && (t.project === project || (t.org_leads ?? []).includes(project));
      return t.org_role === 'main' || ownLead || above.has(id) ? id : undefined;
    };
    const hit = replyInsteadOf({ type, senderTaskId: sender.taskId, senderSessionId: sender.sessionId }, candidates, live, nowMs);
    if (!hit) return null;
    const title = tasks.get(hit.askerTaskId)?.title;
    return { requestId: hit.request.id, taskId: hit.askerTaskId, ...(title ? { title } : {}), status: hit.request.status };
  } catch {
    return null;
  }
}
