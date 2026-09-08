/**
 * Background agents store — the live status of each subagent, by session and by
 * the Agent tool_call's toolUseId, as the Background ledger knows it
 * (session:background-tasks).
 *
 * Why a store and not a context: the ledger snapshot arrives on every
 * task_progress heartbeat (bursts of several per second during a fan-out).
 * Holding it in SessionChatHistory state would re-run the heaviest render body
 * in the app per heartbeat and, through a context value, re-render every Agent
 * card. Here the ledger panel (memo'd, small) publishes, and each card
 * subscribes to ITS OWN entry: an entry object is replaced only when its
 * status or tool count changed, so useSyncExternalStore re-renders exactly the
 * cards whose agent moved.
 */

import { useSyncExternalStore } from 'react';

export interface LiveAgentStatus {
  status: string; // running | completed | failed | stopped | paused
  toolUses?: number;
}

/** Minimal shape the publisher needs (mirrors BackgroundTask). */
export interface LiveAgentSource {
  toolUseId?: string;
  status: string;
  toolUses?: number;
}

const bySession = new Map<string, Map<string, LiveAgentStatus>>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const l of set) l();
}

/** Replace a session's live set. Entries keep their identity when unchanged. */
export function publishLiveAgents(sessionId: string, tasks: readonly LiveAgentSource[]): void {
  const prev = bySession.get(sessionId);
  const next = new Map<string, LiveAgentStatus>();
  let changed = !prev;
  for (const t of tasks) {
    if (!t.toolUseId) continue;
    const old = prev?.get(t.toolUseId);
    if (old && old.status === t.status && old.toolUses === t.toolUses) {
      next.set(t.toolUseId, old);
    } else {
      next.set(t.toolUseId, { status: t.status, toolUses: t.toolUses });
      changed = true;
    }
  }
  if (prev && prev.size !== next.size) changed = true;
  if (!changed) return;
  bySession.set(sessionId, next);
  notify(sessionId);
}

/** Plain read of one agent's live status (what the hook snapshots). */
export function getLiveAgentStatus(sessionId: string | undefined, toolUseId: string | undefined): LiveAgentStatus | null {
  if (!sessionId || !toolUseId) return null;
  return bySession.get(sessionId)?.get(toolUseId) ?? null;
}

export function subscribeLiveAgents(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(sessionId);
  };
}

/** The ledger's live status for one Agent tool_call, or null when the ledger
 *  has nothing for it (the agent predates this session's in-memory task set,
 *  or the page reloaded and no heartbeat has arrived yet) — the card then
 *  falls back to its persisted state. */
export function useLiveAgentStatus(sessionId: string | undefined, toolUseId: string | undefined): LiveAgentStatus | null {
  return useSyncExternalStore(
    (l) => (sessionId ? subscribeLiveAgents(sessionId, l) : () => {}),
    () => getLiveAgentStatus(sessionId, toolUseId),
  );
}
