import { useCallback, useEffect, useSyncExternalStore } from 'react';
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
  const needsRetry = !snapshot.data;

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
