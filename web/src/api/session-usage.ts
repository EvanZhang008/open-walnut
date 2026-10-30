import { apiGet, apiPatch } from './client';

/** A session's budget, as the daemon on its host keeps it (usage-budget-runtime.ts). */
export interface SessionBudget {
  limitUsd: number | null;
  /** The session's cost so far, priced like the model picker's cost line; null before the first check. */
  spentUsd: number | null;
  state: 'unlimited' | 'checking' | 'active' | 'paused';
  /** Why it paused: the limit, or a request with no price. */
  reason: 'limit' | 'unpriced' | 'unreadable' | null;
  revision: number;
  updatedAt: string | null;
  responses: number;
  unpricedResponses: number;
  unpricedModel?: string | null;
  /** Why the last check could not read the session's usage. */
  checkError?: string | null;
  pausedAt: string | null;
  pauseId: string | null;
  stopError?: string | null;
  engine: string | null;
}

export interface SessionUsage {
  sessionId: string;
  title?: string;
  engine: string;
  budget: SessionBudget;
  checkedAt: string | null;
  /** How often the host prices the session between responses. */
  checkEverySec: number;
}

/**
 * How a server that does not answer `absent=null` says "this session has no budget":
 * an engine without per-request usage (400) or a session it does not know (404).
 * Expected, so they stay out of the console.
 */
export const NO_BUDGET_STATUSES: readonly number[] = [400, 404];

/** null: the session has no budget, an engine without per-request usage or a session not recorded yet. */
export async function fetchSessionUsage(sessionId: string, signal?: AbortSignal): Promise<SessionUsage | null> {
  const data = await apiGet<SessionUsage | null | undefined>(`/api/usage/sessions/${encodeURIComponent(sessionId)}`, { absent: 'null' }, { signal, timeoutMs: 10_000, quietStatuses: [...NO_BUDGET_STATUSES] });
  return data ?? null;
}

export function patchSessionBudget(sessionId: string, limitUsd: number | null, revision: number): Promise<SessionUsage> {
  return apiPatch(`/api/usage/sessions/${encodeURIComponent(sessionId)}/budget`, { limitUsd, revision }, { timeoutMs: 35_000, quietStatuses: [409] });
}
