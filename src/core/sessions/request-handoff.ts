/**
 * A request its target handed on: the target named it (`hands_on`) on its ask to another
 * task (session-requests.ts linkHandoffs), so the work went on there. 2026-10-27, Main's
 * reflection: a lead handed Main's request to a worker and ended its turn, and Main heard
 * "WAITING without an explicit reply" every time, though the work had only moved.
 *
 *  - A plain turn end never settles such a request (holdHandedOn). 2026-10-28, Main's reflection:
 *    a lead's turn end after its worker answered settled Main's request with a notice, so the
 *    worker's own answer to Main, later, met a closed request. It settles when the target or
 *    the task that took it over really replies (session-send-core.ts performReply), and at its
 *    deadline, which the link moved past the worker's and the work coming back pulls in again
 *    (session-requests.ts pullInBack), it turns OVERDUE and stays open, its asker told so. A
 *    target that is blocked, errs or closes its task still speaks at once.
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
  // A plain turn end: only a real reply, or the deadline, settles a request handed on.
  return pending.filter((request) => {
    if (!request.carriedBy?.length) return true;
    log.session.info('request fallback held: handed on, only a real reply or its deadline settles it', {
      requestId: request.id, fromSessionId: request.fromSessionId, toTaskId: request.toTaskId,
      carriedBy: request.carriedBy?.map((c) => c.id), phase: edge.phase,
    });
    return false;
  });
}

/**
 * The tasks `request` was handed on to, as its notice names them; undefined when it was not.
 * `words` (the overdue notice): also each task's phase, and the latest message of the one
 * still on it (else the newest), which that notice quotes instead of the target's own.
 */
export async function handedOnFor(request: SessionRequest, opts: { words?: boolean } = {}): Promise<EnvelopeHandedOn[] | undefined> {
  if (!request.carriedBy?.length) return undefined;
  try {
    const { listAllSessionRequests, handedOnOf } = await import('../session-requests.js');
    const rows = await listAllSessionRequests();
    const handed = handedOnOf(request, rows);
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
    const out = [...byTask.values()];
    if (opts.words) {
      const byId = new Map((tasks ?? []).map((t) => [t.id, t] as const));
      for (const h of out) {
        const phase = h.taskId ? byId.get(h.taskId)?.phase : undefined;
        if (phase) h.phase = phase;
      }
      // One transcript read (each may wait seconds): the task still on it, else the newest.
      const focus = out.find((h) => h.state === 'working') ?? out[out.length - 1];
      const ask = [...handed].reverse().find((x) => (x.taskId ?? x.id) === (focus?.taskId ?? ''));
      const sessionId = rows.find((r) => r.id === ask?.id)?.toSessionId
        ?? (focus?.taskId ? byId.get(focus.taskId)?.session_id ?? undefined : undefined);
      if (focus && sessionId) {
        const { readLastWords } = await import('./session-request-notify.js');
        const words = await readLastWords(sessionId).catch(() => undefined);
        if (words) focus.lastMessage = words;
      }
    }
    return out;
  } catch (err) {
    log.session.warn('request notice: could not read where the work was handed on', {
      requestId: request.id, error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
