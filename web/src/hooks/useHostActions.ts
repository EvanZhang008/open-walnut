/**
 * The host buttons' one implementation (banner, picker, Settings, error bar):
 * Retry / Connect now / Update go through connectHost (the server's enabled
 * check, autofix reset and readiness refresh), Check again through
 * checkHostReadiness. Every surface gets the same pending text, the same
 * failure text and the same "same result" receipt.
 *
 * The attempt itself lives in the module store (`host-action-store.ts`), so
 * every surface showing one host reads ONE attempt, and a card that remounts
 * elsewhere keeps its pending line. `fixing` is held until a readiness answer
 * NEWER than the fix's start lands: the server drops `readiness.fixing` a
 * moment before the re-check returns, and showing the old warning in that gap
 * is the 14s flicker this removes.
 */
import { useCallback, useEffect } from 'react';
import { useHostStatus } from '@/hooks/useHostStatus';
import {
  fixVerbOf, observeHostStatus, runHostAction, useHostActionSnapshot,
  type HostActionFailed, type HostActionPending,
} from '@/utils/host-action-store';

export { RETRY_FAILED_TEXT, CHECK_FAILED_TEXT, RECEIPT_MS } from '@/utils/host-action-store';
export type { HostActionPending, HostActionFailed } from '@/utils/host-action-store';
export interface HostFixingView { verb: 'update' | 'install'; startedAt: number }

export interface HostActions {
  retry: () => Promise<void>;
  connectNow: () => Promise<void>;
  /** The autofix: 'update' (a native build updates itself) or 'install' (npm, missing). */
  update: (verb?: 'update' | 'install') => Promise<void>;
  checkAgain: () => Promise<void>;
  pending: HostActionPending;
  failed: HostActionFailed;
  /** 'Tried again just now: same result' / 'Checked just now: still 2.1.220', for 5s. */
  receipt: string | null;
  fixing: HostFixingView | null;
  /** Server time of the last user-started attempt. */
  lastTriedAt: number | null;
}

export function useHostActions(alias: string): HostActions {
  const status = useHostStatus(alias);
  const snap = useHostActionSnapshot(alias);

  const retry = useCallback(() => runHostAction(alias, 'retry'), [alias]);
  const update = useCallback((verb: 'update' | 'install' = 'update') => runHostAction(alias, 'fix', verb), [alias]);
  const checkAgain = useCallback(() => runHostAction(alias, 'check'), [alias]);

  // A mounted surface also carries a fix the server started on its own into the store.
  useEffect(() => { observeHostStatus(alias, status); }, [alias, status]);

  const serverFixing = status?.readiness?.fixing;
  const { fixStart, pending } = snap;
  const fixing: HostFixingView | null = fixStart
    ? { verb: serverFixing ? fixVerbOf(serverFixing.action) : fixStart.verb, startedAt: serverFixing?.startedAt ?? fixStart.at }
    : null;
  return {
    retry, connectNow: retry, update, checkAgain,
    pending: pending === 'fix' ? (fixing ? 'fix' : null) : pending ?? (fixing ? 'fix' : null),
    failed: snap.failed, receipt: snap.receipt, fixing, lastTriedAt: snap.lastTriedAt,
  };
}
