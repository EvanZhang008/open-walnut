/**
 * Telling the sessions that made calls what did not happen as their answer said it would: one
 * notice per session, listing each of its calls. Two callers: the offline handover (writes a host
 * held while the server was away that did not apply, offline-handover.ts) and the held notes
 * (a task_send wake=false note dropped before it reached its target, held-notices-sweep.ts).
 * Each builds its own words (`notice`); this groups, finds each session and delivers. Best effort:
 * a caller that is gone keeps only the log line. Never throws.
 */
import { log } from '../../logging/index.js';

/** One call that did not do what its answer said. */
export interface CallerItem { callerSid: string; op: string; taskId?: string; reason: string }

/** The item as one line of a notice: `- op task: reason`. */
export function callerItemLine(u: CallerItem): string {
  return `- ${u.op}${u.taskId ? ` ${u.taskId}` : ''}: ${u.reason}`;
}

export async function tellCallers(
  items: readonly CallerItem[], notice: (items: CallerItem[]) => string, about: string,
): Promise<number> {
  const bySession = new Map<string, CallerItem[]>();
  for (const u of items) bySession.set(u.callerSid, [...(bySession.get(u.callerSid) ?? []), u]);
  let told = 0;
  try {
    const [{ getSessionByClaudeId }, { deliverToSession }] = await Promise.all([
      import('../session-tracker.js'), import('./session-send-core.js'),
    ]);
    for (const [sid, list] of bySession) {
      try {
        const session = await getSessionByClaudeId(sid);
        if (!session) continue;
        const text = notice(list);
        await deliverToSession(session, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: session.taskId });
        told++;
      } catch (err) {
        log.session.warn(`could not tell the caller about ${about}`, { callerSid: sid, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    log.session.warn(`could not tell the callers about ${about}`, { error: err instanceof Error ? err.message : String(err) });
  }
  return told;
}
