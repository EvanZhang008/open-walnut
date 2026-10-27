/**
 * Where the update notice sits. The desktop rail keeps an empty slot above the bell
 * (Sidebar.tsx), a popout one along its bottom edge (PopoutRoot.tsx), and the notice
 * renders into it, in the flow, so it covers nothing (2026-10-27: floating over the
 * page it sat on the transcript and the composer). The phone layout has no slot, and
 * the notice floats above its bottom bar instead.
 */
import { useSyncExternalStore } from 'react';

let dock: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** A slot (the rail's, a popout's), as a callback ref. */
export function setUpdateNoticeDock(el: HTMLElement | null): void {
  if (dock === el) return;
  dock = el;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useUpdateNoticeDock(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => dock, () => null);
}
