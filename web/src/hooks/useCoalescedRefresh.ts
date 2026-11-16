import { useEffect, useState } from 'react';
import { coalesceRefresh, type CoalescedRefresh } from '@/utils/coalesce-refresh';
import { useCommittedRef } from './useCommittedRef';

/**
 * A component's own coalesced reload (web/src/utils/coalesce-refresh.ts): one run for a burst of
 * signals, one more if a signal lands while it is out. The object keeps its identity for the
 * component's life, so `request` can go in deps and handlers as is; each run calls the `run` of
 * the last committed render, and a pending run is dropped on unmount.
 */
export function useCoalescedRefresh(run: () => Promise<void> | void, delayMs: number): CoalescedRefresh {
  const runRef = useCommittedRef(run);
  const [refresh] = useState(() => coalesceRefresh(async () => { await runRef.current(); }, delayMs));
  useEffect(() => () => refresh.cancel(), [refresh]);
  return refresh;
}
