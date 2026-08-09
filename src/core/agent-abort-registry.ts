/**
 * Per-agent registry of active butler-turn AbortControllers.
 *
 * The WS chat keys its AbortController per client socket + agent (chat.ts) so
 * `chat:stop` aborts only the calling client's turn. A REST client (the iOS
 * app) has no WS identity, so POST /api/v1/conversations/:id/stop needs an
 * agent-level view: every transport that starts a turn registers its
 * AbortController here, and the REST stop aborts ALL of an agent's active
 * turns — for a single-user butler that IS the "stop" the phone means.
 */

const abortersByAgent = new Map<string, Set<AbortController>>();

/** Register a turn's AbortController. Call the returned fn when the turn settles. */
export function registerAgentTurnAbort(agentId: string, controller: AbortController): () => void {
  let set = abortersByAgent.get(agentId);
  if (!set) {
    set = new Set();
    abortersByAgent.set(agentId, set);
  }
  set.add(controller);
  return () => unregisterAgentTurnAbort(agentId, controller);
}

export function unregisterAgentTurnAbort(agentId: string, controller: AbortController): void {
  const set = abortersByAgent.get(agentId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) abortersByAgent.delete(agentId);
}

/** Abort every active turn for an agent. Returns the count of aborted turns. */
export function abortAgentTurns(agentId: string): number {
  const set = abortersByAgent.get(agentId);
  if (!set || set.size === 0) return 0;
  let n = 0;
  for (const c of set) {
    if (!c.signal.aborted) {
      c.abort();
      n++;
    }
  }
  return n;
}

/** True when the agent has at least one registered (possibly running) turn. */
export function hasActiveAgentTurn(agentId: string): boolean {
  return (abortersByAgent.get(agentId)?.size ?? 0) > 0;
}
