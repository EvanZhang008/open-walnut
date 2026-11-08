/**
 * Whether an agent session can start on this computer, as the last system health
 * read said (agentCannotRun: Claude Code missing, unable to start, or signed out).
 * Every "Fix with agent" reads it, so none is offered while the repair session
 * would fail the same way as the error it was asked to fix (review round 2, D08).
 * Fed by useSystemHealth; with no health read yet nothing is blocked.
 */
import { useSyncExternalStore } from 'react';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { agentCannotRun } from '@/utils/local-claude-banner';

let blocked = false;
const listeners = new Set<() => void>();

export function noteLocalAgentHealth(health: SystemHealth | undefined): void {
  const next = agentCannotRun(health);
  if (next === blocked) return;
  blocked = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function localAgentBlocked(): boolean {
  return blocked;
}

export function useLocalAgentBlocked(): boolean {
  return useSyncExternalStore(subscribe, localAgentBlocked, localAgentBlocked);
}
