/**
 * Each host problem row's Show / Hide details choice for the page session, by
 * row id, shared by every place the row renders (the notification panel's
 * problem rows and System's host list), so opening a row in one view keeps it
 * open in the other.
 */
import { useCallback, useSyncExternalStore } from 'react';

const expanded = new Map<string, boolean>();
const listeners = new Set<() => void>();

/** The user's own Show / Hide details choice for a row; undefined = the row's default. */
export function getRowExpanded(id: string): boolean | undefined { return expanded.get(id); }

export function setRowExpanded(id: string, open: boolean): void {
  if (expanded.get(id) === open) return;
  expanded.set(id, open);
  for (const l of listeners) l();
}

export function subscribeRowExpanded(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** A row's expanded flag: the user's choice when there is one, else `fallback`. */
export function useRowExpanded(id: string, fallback: boolean): [boolean, (open: boolean) => void] {
  const get = useCallback(() => getRowExpanded(id), [id]);
  const chosen = useSyncExternalStore(subscribeRowExpanded, get, get);
  const set = useCallback((open: boolean) => setRowExpanded(id, open), [id]);
  return [chosen ?? fallback, set];
}

/** Test hook. */
export function __resetRowExpandedForTests(): void {
  expanded.clear();
  listeners.clear();
}
