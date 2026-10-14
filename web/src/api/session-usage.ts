import { apiGet, apiPatch } from './client';

export interface SessionUsageBreakdown {
  costUsd: number | null;
  calls: number;
  unverifiedCalls: number;
}

export interface SessionUsage {
  sessionId: string;
  title: string;
  verifiedCostUsd: number | null;
  verifiedCalls: number;
  unverifiedCalls: number;
  byModel: (SessionUsageBreakdown & { model: string })[];
  byAgent: (SessionUsageBreakdown & { agent: 'main' | 'subagent' })[];
  budget: {
    limitUsd: number | null;
    spentUsd: number | null;
    state: 'unlimited' | 'active' | 'paused' | 'unverified';
    reason: string | null;
    revision: number;
    updatedAt: string | null;
    stopError?: string | null;
  };
  checkedAt: string | null;
}

export function fetchSessionUsage(sessionId: string, signal?: AbortSignal): Promise<SessionUsage> {
  return apiGet(`/api/usage/sessions/${encodeURIComponent(sessionId)}`, undefined, { signal, timeoutMs: 10_000 });
}

export function patchSessionBudget(sessionId: string, limitUsd: number | null, revision: number): Promise<SessionUsage> {
  return apiPatch(`/api/usage/sessions/${encodeURIComponent(sessionId)}/budget`, { limitUsd, revision }, { timeoutMs: 15_000, quietStatuses: [409] });
}
