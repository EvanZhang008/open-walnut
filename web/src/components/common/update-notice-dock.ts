/**
 * Where the update notice sits. The desktop rail keeps an empty slot above the bell
 * (Sidebar.tsx), a popout one along its bottom edge (PopoutRoot.tsx), and the notice
 * renders into it, in the flow, so it covers nothing (2026-10-27: floating over the
 * page it sat on the transcript and the composer). The phone layout has no slot, and
 * the notice floats above its bottom bar instead.
 */
import { useSyncExternalStore } from 'react';

let dock: HTMLElement | null = null;
let occupied = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** A slot (the rail's, a popout's), as a callback ref. */
export function setUpdateNoticeDock(el: HTMLElement | null): void {
  if (dock === el) return;
  dock = el;
  notify();
}

/**
 * Whether the notice is in the slot now. The popout lays itself out around the bar from
 * this, not from a CSS `:has(:not(:empty))` on the slot: WebKit did not re-match that rule
 * when the notice was portalled in later, so the session kept the full height and pushed
 * the bar below the window (2026-10-27, the Mac app's popouts).
 */
export function setUpdateNoticeOccupied(value: boolean): void {
  if (occupied === value) return;
  occupied = value;
  notify();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useUpdateNoticeDock(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => dock, () => null);
}

export function useUpdateNoticeOccupied(): boolean {
  return useSyncExternalStore(subscribe, () => occupied, () => false);
}
