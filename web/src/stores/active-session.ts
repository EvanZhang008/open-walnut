/**
 * Which session panel is "the current one" — the target for actions taken
 * OUTSIDE any panel that still need a session (a task row's "Quote in session").
 *
 * The Home page can show several session columns at once and nothing else in
 * the app ranks them, so the answer is behavioral: the panel the user last
 * pointed into or focused. Until they have touched one, the leftmost real
 * session column stands in (that is where a newly opened session lands, so it
 * is also the most recently opened). Closing the active panel falls back the
 * same way. Draft and placeholder columns never qualify: a quote targets a
 * conversation that exists.
 *
 * Module-level store (same shape as session-mention-index.ts): panels report
 * in, MainPage reconciles against the open set, menus read + subscribe.
 */
import { useSyncExternalStore } from 'react';
import { isDraftColumnId, isPlaceholderColumnId } from '@/utils/column-ids';

let activeSessionId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

/** A panel the user just pointed into / focused. Cheap and idempotent — panels
 *  call it from a capture-phase pointerdown on every click. */
export function setActiveSession(sessionId: string): void {
  if (isDraftColumnId(sessionId) || isPlaceholderColumnId(sessionId)) return;
  if (activeSessionId === sessionId) return;
  activeSessionId = sessionId;
  emit();
}

/**
 * Keep the answer inside the set of columns actually open (leftmost first).
 * Called by the column owner whenever the strip changes: an active id that is
 * no longer open falls back to the leftmost real session; none open → null.
 */
export function reconcileActiveSession(openColumnIds: string[]): void {
  const real = openColumnIds.filter((id) => !isDraftColumnId(id) && !isPlaceholderColumnId(id));
  const next = activeSessionId && real.includes(activeSessionId) ? activeSessionId : (real[0] ?? null);
  if (next === activeSessionId) return;
  activeSessionId = next;
  emit();
}

export function subscribeActiveSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useActiveSessionId(): string | null {
  return useSyncExternalStore(subscribeActiveSession, getActiveSessionId, getActiveSessionId);
}

/** Test-only reset. */
export function __resetActiveSession(): void {
  activeSessionId = null;
}
