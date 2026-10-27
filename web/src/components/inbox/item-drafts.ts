import { useCallback, useRef, useState, type SetStateAction } from 'react';
import { draftKey, readDraft, writeDraft } from '@/utils/drafts';

// Editing state only. Frozen plans and execution receipts are never saved here.
// Every value lives in this tab; the WORDS (a string field the person typed,
// different from what it started as) are also kept in the draft store, so a
// reload or a restart brings back a half-written title or work goal.
const drafts = new Map<string, Map<string, unknown>>();
const MAX_ITEMS = 200;
const STORED_PREFIX = draftKey('inbox-item', '');

/** Where an item field's words are kept (the element carries it as `data-draft-key`). */
export function itemDraftKey(key: string, field: string): string {
  return draftKey('inbox-item', key, field);
}

export function useItemDraft<T>(key: string, field: string, initial: T) {
  const [value, update] = useState<T>(() => {
    if (drafts.get(key)?.has(field)) return drafts.get(key)!.get(field) as T;
    if (typeof initial === 'string') {
      const stored = readDraft(itemDraftKey(key, field));
      if (stored) return stored as T;
    }
    return initial;
  });
  const initialRef = useRef(initial);
  initialRef.current = initial;
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
    if (typeof value === 'string') writeDraft(itemDraftKey(key, field), value === initialRef.current ? '' : value);
    update(value);
  }, [key, field]);
  return [value, set] as const;
}
export function clearItemDraft(key: string, prefix: string) {
  const entry = drafts.get(key);
  for (const field of entry?.keys() ?? []) if (field.startsWith(prefix)) entry!.delete(field);
  const stored = `${STORED_PREFIX}${key}:${prefix}`;
  try {
    const gone: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(stored)) gone.push(k);
    }
    for (const k of gone) writeDraft(k, '');
  } catch { /* storage off */ }
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
