/**
 * The "Isolated workspace" choice of each open draft, keyed by draft id.
 *
 * Module-level (not on the draft row) so the draft model, its persistence and
 * its many writers stay untouched: the launch reads the choice once, at Start
 * (draftWorkspaceRequest). Off by default; nothing here touches the network.
 * The rules live in draft-workspace-model.ts.
 */
import { useSyncExternalStore } from 'react';
import { applyChoicePatch, workspaceRequestFor, type DraftWorkspaceChoice } from './draft-workspace-model';

export type { DraftWorkspaceChoice };
export { isPickable, selectedCandidate } from './draft-workspace-model';

const EMPTY: DraftWorkspaceChoice = { enabled: false, values: {} };
const choices = new Map<string, DraftWorkspaceChoice>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function getDraftWorkspace(draftId: string): DraftWorkspaceChoice {
  return choices.get(draftId) ?? EMPTY;
}

export function setDraftWorkspace(draftId: string, patch: Partial<DraftWorkspaceChoice>): void {
  choices.set(draftId, applyChoicePatch(getDraftWorkspace(draftId), patch));
  emit();
}

export function useDraftWorkspace(draftId: string): DraftWorkspaceChoice {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => getDraftWorkspace(draftId),
  );
}

/** What the launch sends for this draft (see workspaceRequestFor). */
export function draftWorkspaceRequest(draftId: string): { provider: string; inputs: Record<string, unknown> } | { error: string } | null {
  return workspaceRequestFor(getDraftWorkspace(draftId));
}

/** Test seam. */
export function __resetDraftWorkspacesForTesting(): void {
  choices.clear();
  emit();
}
