import { apiGet, apiPatch, apiPost } from './client';
import type { SessionSummary, SessionRecord } from '@open-walnut/core';
import type { ImageAttachment } from './chat';

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

export interface SessionHistoryResult {
  messages: SessionHistoryMessage[];
  forkBoundaryIndex?: number;
}

export async function fetchSessionHistory(sessionId: string, opts?: { source?: 'streams' }): Promise<SessionHistoryResult> {
  const params = opts?.source ? { source: opts.source } : undefined;
  const res = await apiGet<{ messages: SessionHistoryMessage[]; forkBoundaryIndex?: number }>(`/api/sessions/${sessionId}/history`, params);
  return { messages: res.messages, forkBoundaryIndex: res.forkBoundaryIndex };
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

// ── Quick Start Session ──

export interface WorkingDirEntry {
  cwd: string;
  host: string | null;
  hostLabel?: string;
  category: string;
  count: number;
  lastUsed: string;
}

// Cache working dirs so /session popover opens instantly (prefetched on page load)
let _workingDirsCache: WorkingDirEntry[] | null = null;
let _workingDirsFetching: Promise<WorkingDirEntry[]> | null = null;

export async function fetchWorkingDirs(): Promise<WorkingDirEntry[]> {
  if (_workingDirsCache) return _workingDirsCache;
  if (_workingDirsFetching) return _workingDirsFetching;
  _workingDirsFetching = apiGet<{ dirs: WorkingDirEntry[] }>('/api/sessions/working-dirs')
    .then(res => { _workingDirsCache = res.dirs; _workingDirsFetching = null; return res.dirs; })
    .catch(err => { _workingDirsFetching = null; throw err; });
  return _workingDirsFetching;
}

/** Invalidate cache (e.g. after starting a new session) */
export function invalidateWorkingDirsCache(): void { _workingDirsCache = null; _workingDirsFetching = null; }

export async function listDirs(prefix: string, host?: string | null): Promise<{ dirs: string[]; parent: string }> {
  const params = new URLSearchParams({ prefix });
  if (host) params.set('host', host);
  const res = await apiGet<{ dirs: string[]; parent: string }>(`/api/sessions/list-dirs?${params}`);
  return { dirs: res.dirs, parent: res.parent };
}

// Prefetch working dirs + pre-warm SSH on page load (fire-and-forget).
// Uses the most-frequent path per host (instead of root /) for a useful cache hit.
fetchWorkingDirs().then(dirs => {
  const bestPerHost = new Map<string, string>();
  for (const d of dirs) {
    if (d.host && !bestPerHost.has(d.host)) bestPerHost.set(d.host, d.cwd);
  }
  for (const [host, cwd] of bestPerHost) { listDirs(cwd, host).catch(() => {}); }
}).catch(() => {});

export async function quickStartSession(opts: {
  cwd: string;
  host?: string;
  message: string;
  category?: string;
  model?: string;
  mode?: string;
  images?: ImageAttachment[];
}): Promise<{ taskId: string; task: unknown }> {
  // Convert ImageAttachment[] to the backend ImagePayload format (data + mediaType only)
  const payload: Record<string, unknown> = { ...opts };
  if (opts.images?.length) {
    payload.images = opts.images.map(img => ({ data: img.data, mediaType: img.mediaType }));
  } else {
    delete payload.images;
  }
  const result = await apiPost<{ taskId: string; task: unknown }>('/api/sessions/quick-start', payload);
  invalidateWorkingDirsCache(); // new session → new path entry
  return result;
}

export async function forkSessionInWalnut(
  sessionId: string,
  opts?: { child_title?: string; message?: string; model?: string },
): Promise<{ status: string; sourceSessionId: string; taskId: string; childTaskCreated?: boolean; sessionId?: string }> {
  return apiPost(`/api/sessions/${sessionId}/fork`, {
    create_child_task: true,
    ...opts,
  });
}
