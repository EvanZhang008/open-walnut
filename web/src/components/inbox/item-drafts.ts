import { useCallback, useRef, useState, type SetStateAction } from 'react';

// Tab-local editing state only. Frozen plans and execution receipts are never saved here.
const drafts = new Map<string, Map<string, unknown>>();
const MAX_ITEMS = 200;
export function useItemDraft<T>(key: string, field: string, initial: T) {
  const [value, update] = useState<T>(() => drafts.get(key)?.has(field) ? drafts.get(key)!.get(field) as T : initial);
  const current = useRef(value);
  const set = useCallback((next: SetStateAction<T>) => {
    const value = typeof next === 'function' ? (next as (old: T) => T)(current.current) : next;
    current.current = value;
    let entry = drafts.get(key);
    if (!entry) {
      if (drafts.size >= MAX_ITEMS) drafts.delete(drafts.keys().next().value!);
      entry = new Map(); drafts.set(key, entry);
    }
    entry.set(field, value);
    update(value);
  }, [key, field]);
  return [value, set] as const;
}
export function clearItemDraft(key: string, prefix: string) {
  const entry = drafts.get(key);
  for (const field of entry?.keys() ?? []) if (field.startsWith(prefix)) entry!.delete(field);
}
export function rememberInboxReturn(letterId: string) {
  window.history.replaceState({ ...window.history.state, inboxItemReturn: { letterId, path: location.pathname + location.search } }, '');
}
export function takeInboxReturn(): string | undefined {
  const saved = window.history.state?.inboxItemReturn;
  if (!saved || saved.path !== location.pathname + location.search) return;
  const { inboxItemReturn: _, ...rest } = window.history.state;
  window.history.replaceState(rest, '');
  return typeof saved.letterId === 'string' ? saved.letterId : undefined;
}
