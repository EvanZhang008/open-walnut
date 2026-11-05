import { useSyncExternalStore } from 'react';

/**
 * Whether the notification panel is open (the sidebar owns it). While it is, a
 * pending permission toast would repeat a card the panel already shows, so the
 * toaster leaves those out.
 */
let open = false;
const listeners = new Set<() => void>();

export function setNotificationCenterOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const fn of [...listeners]) fn();
}

export function useNotificationCenterOpen(): boolean {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => open, () => false);
}
