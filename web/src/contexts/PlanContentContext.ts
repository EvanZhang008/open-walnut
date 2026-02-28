import { createContext, useContext } from 'react';

/** Live plan content from useSessionPlan polling — bypasses memo boundaries via context. */
export const PlanContentContext = createContext<string | null>(null);

/** Consume the live plan content. Returns null if no plan is loaded or outside provider. */
export function useLivePlanContent(): string | null {
  return useContext(PlanContentContext);
}
