/**
 * One session timeline's data, read by a second view of it (Tree Mode's split
 * left half, TreeSplitLeft.tsx). The panel's own SessionChatHistory fetches the
 * history and follows the stream, and publishes both here; the left half reads
 * them and fetches nothing itself: no history request of its own per mount, no
 * turn-start / turn-end / reconnect refetch, no second stream to accumulate. A
 * turn therefore costs the same requests with the split on as off.
 *
 * A tiny external store (useSyncExternalStore), so only the reader re-renders
 * when the publisher's data moves, never the panel around both.
 */
import type { UseSessionHistoryReturn } from '@/hooks/useSessionHistory';
import type { UseSessionStreamReturn } from '@/hooks/useSessionStream';

export interface SharedTimeline {
  history: UseSessionHistoryReturn;
  stream: Pick<UseSessionStreamReturn, 'blocks' | 'isStreaming' | 'completedLen'>;
}

export interface TimelineShare {
  get: () => SharedTimeline | null;
  set: (value: SharedTimeline) => void;
  subscribe: (fn: () => void) => () => void;
}

export function createTimelineShare(): TimelineShare {
  let value: SharedTimeline | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const fn of [...subs]) fn();
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
  };
}

const NO_SUBSCRIBE = () => () => {};
const NOTHING = () => null;

/** The arguments for useSyncExternalStore: a reader's share, or none. */
export function shareStoreArgs(share: TimelineShare | undefined): [(fn: () => void) => () => void, () => SharedTimeline | null] {
  return share ? [share.subscribe, share.get] : [NO_SUBSCRIBE, NOTHING];
}
