/**
 * Which topic dialog is open, app-wide: a menu that opens one closes at once, so the dialog lives
 * in one host mounted in App (TopicDialogsHost), opened through this tiny store, the way the raw
 * session view is (SessionRawView).
 *
 *   new  the New topic dialog, with these members already picked
 *   add  the Add to topic picker for these members: an open topic, or a new one
 */
import { useSyncExternalStore } from 'react';
import type { MemberRef } from '@/api/topics';

export interface PickedMember { ref: MemberRef; name: string }

export type TopicDialog =
  | { kind: 'new'; members: PickedMember[] }
  | { kind: 'add'; members: PickedMember[] };

let current: TopicDialog | null = null;
const listeners = new Set<() => void>();
const set = (next: TopicDialog | null) => { current = next; for (const l of listeners) l(); };

export const openNewTopic = (members: PickedMember[] = []): void => set({ kind: 'new', members });
export const openAddToTopic = (members: PickedMember[]): void => set({ kind: 'add', members });
export const closeTopicDialog = (): void => set(null);

export function useTopicDialog(): TopicDialog | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => current,
  );
}
