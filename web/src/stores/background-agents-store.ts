/**
 * Background agents store — the live status of each subagent, by session and by
 * the Agent tool_call's toolUseId, as the Background ledger knows it
 * (session:background-tasks).
 *
 * Why a store and not a context: the ledger snapshot arrives on every
 * task_progress heartbeat (bursts of several per second during a fan-out).
 * Holding it in SessionChatHistory state would re-run the heaviest render body
 * in the app per heartbeat and, through a context value, re-render every chip.
 * Here the ledger panel (memo'd, small) publishes; a chip subscribes to the
 * per-agent map, whose identity only changes when some agent's status or tool
 * count moved, so useSyncExternalStore re-renders exactly the chips that must
 * change; the Background tasks panel subscribes to the whole list.
 */

import { useSyncExternalStore } from 'react';
import type { BackgroundTask } from '@/hooks/useBackgroundTasks';

export interface LiveAgentStatus {
  status: string; // running | completed | failed | stopped | paused
  toolUses?: number;
  /** Server clock at the first task_started (set once; the lane's working
   *  indicator counts its elapsed from here). */
  startedAt?: number;
}

const bySession = new Map<string, Map<string, LiveAgentStatus>>();
/** The last ledger snapshot per session, whole: the Background tasks panel lists
 *  from here instead of running a second ledger hook (which would fetch again on
 *  every open and miss every event that landed before it mounted). */
const tasksBySession = new Map<string, readonly BackgroundTask[]>();
const listeners = new Map<string, Set<() => void>>();

function notify(sessionId: string): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const l of set) l();
}

/** Replace a session's live set. Per-agent entries keep their identity when
 *  unchanged (so a chip subscribed to the per-agent map does not re-render on a
 *  heartbeat that moved nothing), while the whole-list snapshot is replaced on
 *  every publish (tokens and elapsed tick for a panel that is open). */
export function publishLiveAgents(sessionId: string, tasks: readonly BackgroundTask[]): void {
  const prevTasks = tasksBySession.get(sessionId);
  tasksBySession.set(sessionId, tasks);
  const prev = bySession.get(sessionId);
  const next = new Map<string, LiveAgentStatus>();
  let changed = !prev;
  for (const t of tasks) {
    if (!t.toolUseId) continue;
    const old = prev?.get(t.toolUseId);
    if (old && old.status === t.status && old.toolUses === t.toolUses && old.startedAt === t.startedAt) {
      next.set(t.toolUseId, old);
    } else {
      next.set(t.toolUseId, { status: t.status, toolUses: t.toolUses, startedAt: t.startedAt });
      changed = true;
    }
  }
  if (prev && prev.size !== next.size) changed = true;
  if (changed) bySession.set(sessionId, next);
  if (changed || prevTasks !== tasks) notify(sessionId);
}

const EMPTY_TASKS: readonly BackgroundTask[] = [];

/** Plain read of the session's last ledger snapshot. */
export function getLiveTasks(sessionId: string | undefined): readonly BackgroundTask[] {
  if (!sessionId) return EMPTY_TASKS;
  return tasksBySession.get(sessionId) ?? EMPTY_TASKS;
}

/** The session's whole ledger, live — for the Background tasks panel's list. */
export function useLiveTasksForSession(sessionId: string | undefined): readonly BackgroundTask[] {
  return useSyncExternalStore(
    (l) => (sessionId ? subscribeLiveAgents(sessionId, l) : () => {}),
    () => getLiveTasks(sessionId),
  );
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

const EMPTY_SESSION: ReadonlyMap<string, LiveAgentStatus> = new Map();

/** Every live entry of one session, keyed by toolUseId — for a chip that sums N
 *  agents. The map object only changes when some entry changed. */
export function useLiveAgentsForSession(sessionId: string | undefined): ReadonlyMap<string, LiveAgentStatus> {
  return useSyncExternalStore(
    (l) => (sessionId ? subscribeLiveAgents(sessionId, l) : () => {}),
    () => (sessionId ? bySession.get(sessionId) ?? EMPTY_SESSION : EMPTY_SESSION),
  );
}
