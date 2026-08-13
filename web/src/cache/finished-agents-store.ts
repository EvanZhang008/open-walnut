/**
 * finished-agents-store — per-session accumulator for server-transported
 * "orphan finished agent ids" (inc-1786496042099).
 *
 * A NESTED background agent (an Agent spawned by another Agent) streams lane
 * blocks whose parentToolUseId is the nested agent's tool_use id — but that
 * tool_use definition line exists ONLY in the daemon stream file, never in the
 * canonical session JSONL. No history row can ever carry the id, so the lane
 * blocks had no absorption evidence at all and pinned below every later turn
 * forever. The canonical JSONL DOES carry the <task-notification> completion
 * proof; the server parser ships those ids OUTSIDE the messages array as
 * `finishedAgentIds` on every /history response.
 *
 * This store is the client-side home for those ids:
 *  · UNION-accumulating per session — "finished" can only flap to true (a
 *    re-resumed agent re-notifies on its next stop), and a whale session's
 *    sliding tail window can drop old notifications from a later response, so
 *    a shrink must never erase proof we already hold.
 *  · Module-level (same lifetime as cache/session-cache.ts) — survives panel
 *    remounts, so a reopened column re-serves the proof with zero refetch.
 *  · Fed centrally from api/sessions.ts fetchSessionHistory — every consumer
 *    (useSessionHistory, session-cache background refresh, stale retry) flows
 *    through that one function.
 *
 * Reactivity matters: the notification lines that prove a nested agent stopped
 * are HIDDEN from chat (they produce no history row), so a delta response can
 * carry a NEW id with an EMPTY message slice — nothing else would re-render.
 * Components subscribe via useSyncExternalStore (subscribe/get below).
 */

const MAX_SESSIONS = 50;

const EMPTY: ReadonlySet<string> = new Set();

/** sessionId → accumulated finished-agent ids (stable ref until it grows). */
const sets = new Map<string, ReadonlySet<string>>();
const listeners = new Map<string, Set<() => void>>();

/** Union new server-reported ids into the session's set; notifies subscribers
 *  only when the set actually grew. No-op for undefined/empty payloads. */
export function recordFinishedAgentIds(sessionId: string, ids: readonly string[] | undefined): void {
  if (!ids || ids.length === 0) return;
  const prev = sets.get(sessionId);
  let next: Set<string> | undefined;
  for (const id of ids) {
    if (prev?.has(id) || next?.has(id)) continue;
    next ??= new Set(prev ?? []);
    next.add(id);
  }
  if (!next) return; // nothing new — keep the stable ref, no notify
  sets.delete(sessionId); // re-insert for LRU ordering
  sets.set(sessionId, next);
  if (sets.size > MAX_SESSIONS) {
    const oldest = sets.keys().next().value;
    if (oldest) sets.delete(oldest);
  }
  for (const cb of listeners.get(sessionId) ?? []) cb();
}

/** Current accumulated set (stable reference until it grows) — the
 *  useSyncExternalStore snapshot. */
export function getFinishedAgentIds(sessionId: string): ReadonlySet<string> {
  return sets.get(sessionId) ?? EMPTY;
}

/** Subscribe to growth of a session's set — the useSyncExternalStore subscribe. */
export function subscribeFinishedAgentIds(sessionId: string, cb: () => void): () => void {
  let subs = listeners.get(sessionId);
  if (!subs) {
    subs = new Set();
    listeners.set(sessionId, subs);
  }
  subs.add(cb);
  return () => {
    subs.delete(cb);
    if (subs.size === 0) listeners.delete(sessionId);
  };
}

/** Reset all internal state — for tests only. */
export function __resetFinishedAgentsForTesting(): void {
  sets.clear();
  listeners.clear();
}
