/**
 * What a Threads card says it is: its group (core/org/thread-groups.ts threadGroupOf), in the
 * group's own word, with the group's dot. The badge never has a mapping of its own (2026-11-21, a
 * review on his data: a card in Working kept the orange needs dot and the Answer box, one in
 * Waiting / Snoozed read "Pending", one in Closed read "Moved"): the group the card is drawn under
 * is the word it shows. What it waits on, where it moved or which task asks it is said on the card's
 * own lines under the head (Moved to, Asked in, the Acknowledged line). Pure.
 */
import { THREAD_GROUP_LABELS, threadGroupOf, type GroupedThread, type ThreadGroup } from '@open-walnut/thread-groups';

/** Each group's dot. Only Needs you is a colour that asks for him; Working is the agent's move. */
export const GROUP_DOT: Record<ThreadGroup, string> = {
  needs: 'var(--error, #FF3B30)',
  read: 'var(--fg-muted, #86868B)',
  working: 'var(--success, #34C759)',
  waiting: 'var(--fg-muted, #86868B)',
  known: 'var(--fg-muted, #86868B)',
  done: 'var(--fg-muted, #86868B)',
  archived: 'var(--fg-muted, #86868B)',
};

export interface ThreadBadge { group: ThreadGroup; label: string; dot: string }

/** A card's group, word and dot. `listed`: his view lists it now (listedForHim), as groupThreads reads it. Pure. */
export function threadBadge(t: GroupedThread, listed: boolean, now: number): ThreadBadge {
  const group = threadGroupOf(t, listed, now);
  return { group, label: THREAD_GROUP_LABELS[group], dot: GROUP_DOT[group] };
}
