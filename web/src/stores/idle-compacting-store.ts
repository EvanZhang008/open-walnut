/**
 * Which sessions one of Walnut's own compactions runs in now, and which one: the idle compaction
 * (src/core/sessions/idle-compaction.ts) and the context-full recovery
 * (src/core/sessions/context-full-recovery.ts, `reason: 'context'`) broadcast
 * session:idle-compaction when it starts and when it ends, however it ends.
 *
 * Its turn is quiet: the CLI runs, but the task does no work of its own, so a task's circle and its
 * panel's composer read this before they read "running" (2026-11-04 review: the list's circle pulsed
 * as Working for the whole compaction).
 */
import { useSyncExternalStore } from 'react';
import { wsClient, type ConnectionState } from '@/api/ws';

export const IDLE_COMPACTION_EVENT = 'session:idle-compaction';

/** Which of Walnut's compactions runs: the working line says which. */
export type WalnutCompaction = 'idle' | 'context';

const compacting = new Map<string, WalnutCompaction>();
const listeners = new Set<() => void>();
let started = false;
/** The end comes before the CLI's own status leaves running: the session reads as compacting a moment longer. */
export const IDLE_COMPACTING_END_GRACE_MS = 2_000;
const ending = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l();
}

/** Applies one session:idle-compaction event; exported for tests. */
export function ingestIdleCompaction(data: unknown): void {
  const { sessionId, active, reason } = (data ?? {}) as { sessionId?: unknown; active?: unknown; reason?: unknown };
  if (typeof sessionId !== 'string' || !sessionId) return;
  const pending = ending.get(sessionId);
  if (pending) { clearTimeout(pending); ending.delete(sessionId); }
  if (active === true) {
    const kind: WalnutCompaction = reason === 'context' ? 'context' : 'idle';
    if (compacting.get(sessionId) !== kind) { compacting.set(sessionId, kind); emit(); }
    return;
  }
  if (!compacting.has(sessionId)) return;
  emit();
  ending.set(sessionId, setTimeout(() => {
    ending.delete(sessionId);
    if (compacting.delete(sessionId)) emit();
  }, IDLE_COMPACTING_END_GRACE_MS));
}

function start(): void {
  if (started) return;
  started = true;
  wsClient.onEvent(IDLE_COMPACTION_EVENT, ingestIdleCompaction);
  // A reconnect may have missed an end: forget them all rather than hide a real turn.
  wsClient.onConnectionChange((state: ConnectionState) => {
    if (state === 'connected' && compacting.size > 0) {
      for (const t of ending.values()) clearTimeout(t);
      ending.clear();
      compacting.clear();
      emit();
    }
  });
}

export const idleCompactingStore = {
  subscribe(listener: () => void): () => void {
    start();
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** `exact`: not in the moment after its end (the composer: a turn that follows shows its Stop at once). */
  has(sessionId: string | null | undefined, exact = false): boolean {
    return idleCompactingStore.kind(sessionId, exact) !== null;
  },
  /** Which compaction runs in the session now, or null; `exact` as in has(). */
  kind(sessionId: string | null | undefined, exact = false): WalnutCompaction | null {
    start();
    if (!sessionId || (exact && ending.has(sessionId))) return null;
    return compacting.get(sessionId) ?? null;
  },
  /** Tests only. */
  resetForTest(): void {
    for (const t of ending.values()) clearTimeout(t);
    ending.clear();
    compacting.clear();
  },
};

/** Which of Walnut's compactions runs in this session now, or null. */
export function useWalnutCompactingSession(sessionId: string | null | undefined, exact = false): WalnutCompaction | null {
  return useSyncExternalStore(
    idleCompactingStore.subscribe,
    () => idleCompactingStore.kind(sessionId, exact),
    () => idleCompactingStore.kind(sessionId, exact),
  );
}

/** Whether one of Walnut's compactions runs in this session now. */
export function useIdleCompactingSession(sessionId: string | null | undefined, exact = false): boolean {
  return useSyncExternalStore(
    idleCompactingStore.subscribe,
    () => idleCompactingStore.has(sessionId, exact),
    () => idleCompactingStore.has(sessionId, exact),
  );
}
