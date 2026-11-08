/**
 * A message parked because the coding agent cannot run on its session's host yet
 * (Claude Code not installed, unable to start, or signed out: AGENT_CANNOT_RUN_KINDS)
 * goes out by itself once that host reads runnable. Review round 2, D08: a first
 * message typed before Claude Code was installed said "this message waits here", and
 * after the install and the sign-in nothing sent it.
 *
 * The parked row carries the readiness kind it waits on (QueuedMessage.waitsFor, set
 * from the delivery verdict). The two readiness stores (this machine's,
 * hosts/local-readiness.ts, and every remote host's, hosts/host-readiness-store.ts)
 * are watched; when a host turns runnable (from not runnable, or from never asked, as
 * after a restart), its waiting rows are put back in line, the way a host reconnect
 * redelivers its pending rows (claude-code-session.ts redeliverPendingForHost):
 *   - once per turn to runnable: a row refused again is parked again, waiting for the
 *     next turn, so a readiness answer the spawn disagrees with never loops;
 *   - the same rules as a person's Retry: a row a Stop came after stays parked for
 *     the person (its stop fence is not the session's now), a deleted row is gone, and
 *     a line the daemon says already ran is settled as delivered, never sent twice
 *     (sessions/resend-already-ran.ts);
 *   - an archived session is left alone, as a reconnect leaves it.
 * A row also rides ahead of any other row of its session that goes out (processNext).
 */
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import { AGENT_CANNOT_RUN_KINDS } from '../hosts/host-problem.js';

/** When Walnut sends a row waiting on that kind: the host reads runnable (agentRunnable). */
export type AgentWaitRule = 'host-runnable';

/**
 * Every readiness kind a row can wait on, and the rule that sends it. A kind with no rule
 * here would park for good (only a Retry sends it): the guard test fails on a kind of
 * AGENT_CANNOT_RUN_KINDS or a ClaudeRuntimeMissingError kind not listed.
 */
export const AGENT_WAIT_RESEND: Readonly<Record<string, AgentWaitRule>> = {
  claude_missing: 'host-runnable',
  claude_needs_node: 'host-runnable',
  claude_error: 'host-runnable',
  claude_not_logged_in: 'host-runnable',
};

/** The slice of a readiness answer (local or remote) the rule reads. */
export interface AgentReadinessView {
  claude?: { found?: boolean; unknown?: string | boolean };
  problems?: ReadonlyArray<{ kind: string }>;
  checkError?: string;
}

/** The agent can run there now: found, the answer settled, no AGENT_CANNOT_RUN kind left. */
export function agentRunnable(r: AgentReadinessView | undefined): boolean {
  if (!r || r.checkError || !r.claude?.found || r.claude.unknown) return false;
  return !(r.problems ?? []).some((p) => AGENT_CANNOT_RUN_KINDS.includes(p.kind));
}

/**
 * Put the host's waiting rows back in line and drive delivery. Returns the ids sent
 * again (rows settled as already ran are not among them).
 */
export async function resendAgentWaitRows(hostKey: string): Promise<string[]> {
  const { sessionsWithAgentWaitRows, getQueue, removeProcessed, unparkAgentWaitRows } = await import('../session-message-queue.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const { sessionStops } = await import('./session-stop.js');
  const { resendAlreadyRan } = await import('./resend-already-ran.js');
  const sent: string[] = [];
  for (const sessionId of await sessionsWithAgentWaitRows()) {
    try {
      const record = await getSessionByClaudeId(sessionId);
      if (!record || record.archived || (record.host ?? '__local__') !== hostKey) continue;
      // A Stop waiting for its host: nothing goes out until it is settled.
      const fence = await sessionStops.fence(sessionId).catch(() => undefined);
      if (fence === undefined) continue;
      const waiting = (await getQueue(sessionId)).filter((m) => m.status === 'parked' && !!m.waitsFor
        && AGENT_WAIT_RESEND[m.waitsFor] === 'host-runnable' && (m.stopFence ?? null) === fence);
      if (waiting.length === 0) continue;
      // A line that went out before (lineTries) and that the daemon says ran: settled, not sent twice.
      const ran: string[] = [];
      for (const m of waiting) {
        if (!m.lineUuid || !(m.lineTries && m.lineTries > 1)) continue;
        if (await resendAlreadyRan({ sessionId, host: record.host, lineUuid: m.lineUuid, messageIds: [m.id] })) ran.push(m.id);
      }
      if (ran.length > 0) {
        await removeProcessed(sessionId, ran);
        bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId, count: ran.length, messageIds: ran }, ['main-ai'], { source: 'agent-ready' });
      }
      const ids = await unparkAgentWaitRows(sessionId, fence);
      if (ids.length === 0) continue;
      sent.push(...ids);
      log.session.info('the agent can run now: sending the messages that waited for it', { sessionId, hostKey, messageIds: ids });
      bus.emit(EventNames.SESSION_SEND, { sessionId, message: '', ...(record.taskId ? { taskId: record.taskId } : {}) }, ['session-runner'], { source: 'agent-ready' });
    } catch (err) {
      log.session.warn('sending the messages that waited for the agent failed', {
        sessionId, hostKey, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return sent;
}

const lastRunnable = new Map<string, boolean>();
const chains = new Map<string, Promise<unknown>>();

/** One readiness answer for `hostKey`: a turn to runnable sends its waiting rows, once. */
export function noteAgentReadiness(hostKey: string, runnable: boolean): Promise<string[]> | undefined {
  const was = lastRunnable.get(hostKey);
  lastRunnable.set(hostKey, runnable);
  if (!runnable || was === true) return undefined;
  const run = (chains.get(hostKey) ?? Promise.resolve()).catch(() => {}).then(() => resendAgentWaitRows(hostKey));
  chains.set(hostKey, run);
  void run.finally(() => { if (chains.get(hostKey) === run) chains.delete(hostKey); }).catch(() => {});
  return run;
}

/** Server wiring: watch this machine's and every remote host's readiness. Returns an unsubscribe. */
export async function wireAgentWaitResend(): Promise<() => void> {
  const { onLocalClaudeChange, getLocalClaude } = await import('../hosts/local-readiness.js');
  const { onHostReadinessChange, getHostReadiness } = await import('../hosts/host-readiness-store.js');
  const offLocal = onLocalClaudeChange((status) => { void noteAgentReadiness('__local__', agentRunnable(status)); });
  const offHosts = onHostReadinessChange((host) => { void noteAgentReadiness(host, agentRunnable(getHostReadiness(host))); });
  // An answer already in hand (the probe ran before this wiring): judge it now.
  const now = getLocalClaude();
  if (now) void noteAgentReadiness('__local__', agentRunnable(now));
  return () => { offLocal(); offHosts(); };
}

/** Test seam. */
export function resetAgentWaitResendForTests(): void {
  lastRunnable.clear();
  chains.clear();
}
