import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { fetchSessionUsage, patchSessionBudget } from '@/api/session-usage';
import { SessionUsageStore } from '@/stores/session-usage-store';
import { useEvent } from '@/hooks/useWebSocket';

export const sessionUsageStore = new SessionUsageStore({ fetch: fetchSessionUsage, patch: patchSessionBudget });

export function useSessionBudgetUsage(sessionId: string, dialogVisible: boolean) {
  const subscribe = useCallback((listener: () => void) => sessionUsageStore.subscribe(sessionId, listener), [sessionId]);
  const getSnapshot = useCallback(() => sessionUsageStore.getSnapshot(sessionId), [sessionId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => sessionUsageStore.refresh(sessionId), [sessionId]);
  const save = useCallback((limitUsd: number | null, revision: number) => sessionUsageStore.save(sessionId, limitUsd, revision), [sessionId]);
  const configured = snapshot.data?.budget.limitUsd != null;
  // An engine without per-request usage (400) or a session the server does not know (404) has no budget to wait for.
  const needsRetry = !snapshot.data && snapshot.errorStatus !== 400 && snapshot.errorStatus !== 404;

  useEffect(() => { void refresh(); }, [refresh, dialogVisible]);
  useEffect(() => {
    if (!dialogVisible && !configured && !needsRetry) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, dialogVisible ? 5_000 : 15_000);
    return () => clearInterval(interval);
  }, [refresh, dialogVisible, configured, needsRetry]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [refresh]);
  useEvent('_ws:reconnected', () => { void refresh(); });
  useEvent('session:result', (event) => {
    if ((event as { sessionId?: string } | null)?.sessionId === sessionId) void refresh();
  });
  useEvent('session:status-changed', (event) => {
    if ((event as { sessionId?: string } | null)?.sessionId === sessionId && (dialogVisible || configured)) void refresh();
  });
  return { ...snapshot, refresh, save };
}

export type SessionUsageView = ReturnType<typeof useSessionBudgetUsage>;

/** Opens the session's Usage & Budget dialog; provided by SessionPanel, read by the picker's cost block. */
export const SessionUsageOpenContext = createContext<((sessionId: string) => void) | null>(null);
export function useOpenSessionUsage() { return useContext(SessionUsageOpenContext); }
