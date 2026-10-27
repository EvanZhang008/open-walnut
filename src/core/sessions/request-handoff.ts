/**
 * A request its target handed on: the target named it (`hands_on`) on its ask to another
 * task (session-requests.ts linkHandoffs), so the work went on there. 2026-10-27, Main's
 * reflection: a lead handed Main's request to a worker and ended its turn, and Main heard
 * "WAITING without an explicit reply" every time, though the work had only moved.
 *
 *  - The turn-end fallback holds such a request while an answer is still owed to its target
 *    (holdHandedOn): a turn that parked, waiting for the worker, is not "no reply". It speaks
 *    once the work is back and the target still said nothing (a task it went to that closed
 *    or is gone counts as back), when the target is blocked, errs or closes its task, and at
 *    the deadline, which the link moved past the worker's and the work coming back pulls in
 *    again (session-requests.ts pullInBack).
 *  - Whenever it speaks, it names the tasks the work went to and whether each answered
 *    (handedOnFor), so the asker knows where to look.
 * A reply from the target settles the request as before; nothing here speaks for it then.
 */
import type { SessionRequest, SessionRequestOutcome } from '../session-requests.js';
import type { EnvelopeHandedOn } from '../peers/envelope-kit.js';
import { log } from '../../logging/index.js';

/** The pending requests whose turn-end fallback speaks at this edge. */
export async function holdHandedOn(
  pending: readonly SessionRequest[],
  edge: { outcome: Exclude<SessionRequestOutcome, 'timeout'>; phase?: string },
): Promise<SessionRequest[]> {
  if (!pending.some((r) => r.carriedBy?.length)) return [...pending];
  // Blocked, failed or closed: the asker hears now, with who still has the work.
  if (edge.outcome !== 'completed' || edge.phase === 'COMPLETE') return [...pending];
  const { listAllSessionRequests, carriedState } = await import('../session-requests.js');
  // An unreadable ledger holds nothing: the notice as before is better than none.
  const rows = await listAllSessionRequests().catch(() => null);
  if (!rows) return [...pending];
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  // The asks still out, and whether the task each went to is still there to answer it.
  const out = pending.flatMap((r) => (r.carriedBy ?? []).filter((c) => byId.get(c.id)?.status === 'pending'));
  const taskIds = [...new Set(out.map((c) => c.taskId).filter((id): id is string => !!id))];
  let open: Set<string> | null = null;
  if (taskIds.length) {
    try {
      const { listTasksByIds } = await import('../task-manager.js');
      open = new Set((await listTasksByIds(taskIds)).filter((t) => t.phase !== 'COMPLETE').map((t) => t.id));
    } catch { open = null; /* unknown: the asks count as out, the deadline still speaks */ }
  }
  // A task that closed without answering, or is gone, never will: its work is back.
  const stillOut = (c: { taskId?: string }) => !c.taskId || !open || open.has(c.taskId);
  return pending.filter((request) => {
    if (carriedState(request, rows) !== 'out') return true;
    if (!(request.carriedBy ?? []).some((c) => byId.get(c.id)?.status === 'pending' && stillOut(c))) return true;
    log.session.info('request fallback held: handed on, and that answer is still owed', {
      requestId: request.id, fromSessionId: request.fromSessionId, toTaskId: request.toTaskId,
      carriedBy: request.carriedBy?.map((c) => c.id), phase: edge.phase,
    });
    return false;
  });
}

/** The tasks `request` was handed on to, as its notice names them; undefined when it was not. */
export async function handedOnFor(request: SessionRequest): Promise<EnvelopeHandedOn[] | undefined> {
  if (!request.carriedBy?.length) return undefined;
  try {
    const { listAllSessionRequests, handedOnOf } = await import('../session-requests.js');
    const handed = handedOnOf(request, await listAllSessionRequests());
    const ids = [...new Set(handed.map((h) => h.taskId).filter((id): id is string => !!id))];
    const { listTasksByIds } = await import('../task-manager.js');
    const tasks = await listTasksByIds(ids).catch(() => null);
    const titles = new Map((tasks ?? []).map((t) => [t.id, t.title] as const));
    // A task that closed without answering, or is gone, is not working on it any more.
    const ended = (id: string | undefined) => !!id && !!tasks && !tasks.some((t) => t.id === id && t.phase !== 'COMPLETE');
    // One line per task: its latest ask decides (a second ask to the same task supersedes the first).
    const byTask = new Map<string, EnvelopeHandedOn>();
    for (const h of handed) {
      const state: EnvelopeHandedOn['state'] = h.status === 'replied' ? 'answered'
        : h.status === 'notified' ? 'stopped'
          : h.status === 'pending' ? (ended(h.taskId) ? 'stopped' : 'working')
            : 'unknown';
      byTask.set(h.taskId ?? h.id, { ...(h.taskId ? { taskId: h.taskId } : {}), ...(h.taskId && titles.get(h.taskId) ? { title: titles.get(h.taskId) } : {}), state });
    }
    return [...byTask.values()];
  } catch (err) {
    log.session.warn('request notice: could not read where the work was handed on', {
      requestId: request.id, error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
