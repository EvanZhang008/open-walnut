import { createContext, useContext } from 'react';

/** The live plan with its writer (a from-plan session shows another session's plan). */
export interface LivePlan {
  content: string;
  /** The plan's writer: the panel's own session, or the session it was started from. */
  writerSessionId: string;
}

/** Live plan content from useSessionPlan polling — bypasses memo boundaries via context. */
export const PlanContentContext = createContext<LivePlan | null>(null);

/** Consume the live plan. Returns null if no plan is loaded or outside provider. */
export function useLivePlanContent(): LivePlan | null {
  return useContext(PlanContentContext);
}
