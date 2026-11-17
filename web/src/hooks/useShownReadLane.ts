import { useEffect, useRef } from 'react';
import { fetchLaneRaised, type FetchLane } from '@/api/client';
import { useCommittedRef } from './useCommittedRef';

/**
 * A read's claim to the connection kept for what the person waits on (api/client.ts
 * INTERACTIVE_RESERVED), following whether its page is on show. `lane()` makes the claim of a read
 * starting now: interactive while shown, shared otherwise. The newest claim still waiting when the
 * page comes on show is raised, so a chat that mounts a moment before its page shows (opened from
 * another route) does not wait out the shared queue for it. Raising a read already sent is a no-op.
 */
export function useShownReadLane(shown: boolean): () => FetchLane {
  const shownRef = useCommittedRef(shown);
  const latest = useRef<FetchLane | null>(null);
  useEffect(() => {
    const lane = latest.current;
    if (!shown || !lane || lane.interactive) return;
    lane.interactive = true;
    fetchLaneRaised();
  }, [shown]);
  const make = useRef(() => (latest.current = { interactive: shownRef.current })).current;
  return make;
}
