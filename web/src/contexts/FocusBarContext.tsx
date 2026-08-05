import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useFocusBar, type UseFocusBarReturn } from '@/hooks/useFocusBar';

const FocusBarContext = createContext<UseFocusBarReturn | null>(null);

export function FocusBarProvider({ children }: { children: ReactNode }) {
  // useFocusBar derives everything from TasksContext — task objects' pinned /
  // focus_tier / pin_order fields are the single client-side source of truth.
  const focusBar = useFocusBar();
  // Stabilize context value: only update when focus bar STATE changes (IDs or visibility),
  // NOT when task data changes. Task[] arrays (pinnedTasks, focusTasks, etc.) always get
  // new references when `tasks` changes, which would cause a double-trigger cascade:
  // task:updated → TasksContext change → MainPage render AND FocusBarContext change →
  // MainPage render again → TodoPanel filtered recalc → setSortOrder → exceeds max depth.
  // The ID arrays are identity-stable (useStableIds), so pin/tier/order changes —
  // and only those — refresh the context. Consumers that need fresh task data
  // already get it from TasksContext.
  const value = useMemo<UseFocusBarReturn>(() => focusBar,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only IDs + tier defs + visible trigger context update
    [focusBar.pinnedIds, focusBar.focusIds, focusBar.satelliteIds, focusBar.backlogIds, focusBar.waitIds,
     focusBar.customTiers, focusBar.customTiersLoaded, focusBar.customTierIds,
     focusBar.visible]);
  return <FocusBarContext.Provider value={value}>{children}</FocusBarContext.Provider>;
}

export function useFocusBarContext(): UseFocusBarReturn {
  const ctx = useContext(FocusBarContext);
  if (!ctx) throw new Error('useFocusBarContext must be used within FocusBarProvider');
  return ctx;
}

/**
 * Null-tolerant variant for deep/shared components (kebab menus, pickers) that
 * may render outside the provider (e.g. isolated pages/tests) — they degrade to
 * "no custom tiers" instead of crashing.
 */
export function useFocusBarContextSafe(): UseFocusBarReturn | null {
  return useContext(FocusBarContext);
}
