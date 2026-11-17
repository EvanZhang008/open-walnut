import { useEffect, useRef } from 'react';
import { fetchLaneRaised, type FetchLane } from '@/api/client';
import { useCommittedRef } from './useCommittedRef';

/**
 * A read's claim to the connection kept for what the person waits on (api/client.ts
 * INTERACTIVE_RESERVED), following whether its page is on show. `lane()` makes the claim of a read
 * starting now: interactive while shown, shared otherwise. The newest claim still waiting when the
 * page comes on show is raised, so a chat that mounts a moment before its page shows (opened from
 * another route) does not wait out the shared queue for it. Raising a read already sent is a no-op.
 *
 * `key` names what the reads are for (the panel's session): a claim made for another key is never
 * raised, so when the session and the page's show change in one commit the old session's claim
 * stays shared (that effect runs before the new read makes its claim).
 */
export function useShownReadLane(shown: boolean, key: string): () => FetchLane {
  const shownRef = useCommittedRef(shown);
  const keyRef = useCommittedRef(key);
  const latest = useRef<{ key: string; lane: FetchLane } | null>(null);
  useEffect(() => {
    const claim = latest.current;
    if (!shown || !claim || claim.key !== key || claim.lane.interactive) return;
    claim.lane.interactive = true;
    fetchLaneRaised();
  }, [shown, key]);
  const make = useRef(() => {
    const lane: FetchLane = { interactive: shownRef.current };
    latest.current = { key: keyRef.current, lane };
    return lane;
  }).current;
  return make;
}
