/**
 * Which routers have their settings section open in this tab, so the page's other "Open settings"
 * buttons (the paused router's idle line, Mail's From Mail line) show only while it is folded.
 * OrgRouterSettings writes it; the open state itself stays kept by usePageViewOf there.
 */
import { useSyncExternalStore } from 'react';

const open = new Set<string>();
const listeners = new Set<() => void>();

export function setRouterSettingsOpen(id: string, isOpen: boolean): void {
  if (open.has(id) === isOpen) return;
  if (isOpen) open.add(id); else open.delete(id);
  for (const l of listeners) l();
}

export function useRouterSettingsOpen(id: string): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => open.has(id),
    () => false,
  );
}
