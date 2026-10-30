import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { fetchSessionUsage, NO_BUDGET_STATUSES, patchSessionBudget } from '@/api/session-usage';
import { SessionUsageStore } from '@/stores/session-usage-store';
import { useEvent } from '@/hooks/useWebSocket';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { engineHasBudget } from '@open-walnut/budget-engines';

export const sessionUsageStore = new SessionUsageStore({ fetch: fetchSessionUsage, patch: patchSessionBudget });

export function useSessionBudgetUsage(sessionId: string, dialogVisible: boolean) {
  const subscribe = useCallback((listener: () => void) => sessionUsageStore.subscribe(sessionId, listener), [sessionId]);
  const getSnapshot = useCallback(() => sessionUsageStore.getSnapshot(sessionId), [sessionId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // A session whose engine records no per-request usage has no budget: never ask
  // (the answer is a 400 the browser logs as an error, on every panel of such a session).
  const engine = useSessionStatus(sessionId)?.engine;
  const noBudget = engine != null && !engineHasBudget(engine);
  const refresh = useCallback(
    () => noBudget ? Promise.resolve(null) : sessionUsageStore.refresh(sessionId),
    [sessionId, noBudget],
  );
  const save = useCallback((limitUsd: number | null, revision: number) => sessionUsageStore.save(sessionId, limitUsd, revision), [sessionId]);
  const configured = snapshot.data?.budget.limitUsd != null;
  // An engine without per-request usage or a session the server does not know has no budget to wait for.
  const needsRetry = !snapshot.data && !snapshot.noBudget
    && !(snapshot.errorStatus != null && NO_BUDGET_STATUSES.includes(snapshot.errorStatus));

  useEffect(() => { void refresh(); }, [refresh, dialogVisible]);
  useEffect(() => {
    if (noBudget || (!dialogVisible && !configured && !needsRetry)) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, dialogVisible ? 5_000 : 15_000);
    return () => clearInterval(interval);
  }, [refresh, dialogVisible, configured, needsRetry, noBudget]);
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
