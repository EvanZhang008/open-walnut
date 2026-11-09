/**
 * Who is writing to an Org node's Threads, and from which session (2026-11-07: a thread summary's
 * path opened on the node's current machine, not on the one that wrote it).
 *
 * Read once per request from `x-walnut-caller-sid`, through the session registry: the writer
 * (`by`, the same mapping the Board uses: boards/board-team.ts boardWriter) and, for a session
 * Walnut knows, its id and host as the registry records them. A request body never names either:
 * a sid or host in it is ignored. A header Walnut cannot place (an unknown or replaced session) is
 * an agent with no source, so its words read as written by an unknown session; no header is the
 * user, whose words are the primary's.
 */
import { normalizeHost, resolveCallerPlacement, type CallerSession } from '../sessions/caller-placement.js';
import type { ThreadTextSource, ThreadWriter } from './threads-model.js';

export interface ThreadCaller {
  by: ThreadWriter;
  /** The caller's own session, verified; absent for the user and for a caller Walnut could not place. */
  source?: ThreadTextSource;
}

function sourceOf(session: CallerSession): ThreadTextSource | undefined {
  const sid = session.id?.trim();
  if (!sid) return undefined;
  // normalizeHost gives '' for this machine; the stored form names it.
  return { sid, host: normalizeHost(session.host) || '__local__' };
}

export async function resolveThreadCaller(callerSid: string | undefined): Promise<ThreadCaller> {
  const caller = await resolveCallerPlacement(callerSid);
  if (caller.kind === 'human') return { by: 'human' };
  if (caller.kind === 'ask' || caller.kind === 'worker') {
    const source = sourceOf(caller.session);
    return { by: `task:${caller.task.id}`, ...(source ? { source } : {}) };
  }
  if (caller.kind === 'untracked') {
    const source = sourceOf(caller.session);
    return { by: 'agent', ...(source ? { source } : {}) };
  }
  return { by: 'agent' };
}
