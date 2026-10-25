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

export function fetchSessionUsage(sessionId: string, signal?: AbortSignal): Promise<SessionUsage> {
  return apiGet(`/api/usage/sessions/${encodeURIComponent(sessionId)}`, undefined, { signal, timeoutMs: 10_000 });
}

export function patchSessionBudget(sessionId: string, limitUsd: number | null, revision: number): Promise<SessionUsage> {
  return apiPatch(`/api/usage/sessions/${encodeURIComponent(sessionId)}/budget`, { limitUsd, revision }, { timeoutMs: 35_000, quietStatuses: [409] });
}
