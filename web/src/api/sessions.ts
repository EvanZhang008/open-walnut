import { apiGet, apiPatch, apiPost } from './client';
import type { SessionSummary, SessionRecord } from '@walnut/core';

export async function fetchSessions(): Promise<SessionSummary[]> {
  const res = await apiGet<{ sessions: SessionSummary[] }>('/api/sessions');
  return res.sessions;
}

export async function fetchRecentSessions(limit?: number): Promise<SessionSummary[]> {
  const params = limit ? { limit: String(limit) } : undefined;
  const res = await apiGet<{ sessions: SessionSummary[] }>('/api/sessions/recent', params);
  return res.sessions;
}

export async function fetchSessionSummaries(limit?: number): Promise<SessionSummary[]> {
  const params = limit ? { limit: String(limit) } : undefined;
  const res = await apiGet<{ summaries: SessionSummary[] }>('/api/sessions/summaries', params);
  return res.summaries;
}

// Re-export from canonical types
export type { SessionHistoryMessage } from '@/types/session';

export async function fetchSessionHistory(sessionId: string, opts?: { source?: 'streams' }): Promise<SessionHistoryMessage[]> {
  const params = opts?.source ? { source: opts.source } : undefined;
  const res = await apiGet<{ messages: SessionHistoryMessage[] }>(`/api/sessions/${sessionId}/history`, params);
  return res.messages;
}

export async function updateSession(sessionId: string, updates: { title?: string; human_note?: string; work_status?: string; archived?: boolean; archive_reason?: string }): Promise<SessionRecord> {
  const res = await apiPatch<{ session: SessionRecord }>(`/api/sessions/${sessionId}`, updates);
  return res.session;
}

export async function fetchSessionsForTask(taskId: string): Promise<SessionRecord[]> {
  const res = await apiGet<{ sessions: SessionRecord[] }>(`/api/sessions/task/${taskId}`);
  return res.sessions;
}

import type { SessionTreeResponse } from '@/types/session';

export async function fetchSessionTree(hideCompleted?: boolean): Promise<SessionTreeResponse> {
  const params = hideCompleted ? { hideCompleted: 'true' } : undefined;
  const res = await apiGet<SessionTreeResponse>('/api/sessions/tree', params);
  return res;
}

export async function fetchSession(sessionId: string): Promise<SessionRecord | null> {
  try {
    const res = await apiGet<{ session: SessionRecord }>(`/api/sessions/${sessionId}`);
    return res.session;
  } catch {
    return null;
  }
}

export interface SessionPlanResponse {
  content: string;
  planFile?: string;
  sourceSessionId?: string;
}

export async function fetchSessionPlan(sessionId: string): Promise<SessionPlanResponse | null> {
  try {
    return await apiGet<SessionPlanResponse>(`/api/sessions/${sessionId}/plan`);
  } catch {
    return null;
  }
}

export async function executePlanSession(
  sessionId: string,
  opts?: { task_id?: string; working_directory?: string; instructions?: string; mode?: string },
): Promise<{ status: string; planSessionId: string; taskId: string; mode: string; sessionId?: string }> {
  return apiPost(`/api/sessions/${sessionId}/execute`, opts ?? {});
}

export async function executePlanContinue(sessionId: string): Promise<{ status: string; sessionId: string }> {
  return apiPost(`/api/sessions/${sessionId}/execute-continue`, {});
}
