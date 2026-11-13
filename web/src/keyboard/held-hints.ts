/**
 * Whether the keys' hints are up: the session-switching modifier held alone on Home
 * (pages/useHomeKeyboard.ts sets it). The column numbers read it there; a button that has a
 * command (New task, a column's close) reads it through ShortcutHint.
 */
import { useSyncExternalStore } from 'react';

let shown = false;
const listeners = new Set<() => void>();

export function setHeldHints(v: boolean): void {
  if (shown === v) return;
  shown = v;
  for (const l of listeners) l();
}

export function heldHintsShown(): boolean {
  return shown;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useHeldHints(): boolean {
  return useSyncExternalStore(subscribe, heldHintsShown, () => false);
}
