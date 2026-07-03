import { apiGet, apiPatch, apiPost } from './client';
import type { SessionSummary, SessionRecord, SessionEffort } from '@open-walnut/core';
import type { ImageAttachment } from './chat';
import { log } from '@/utils/log';

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

export async function fetchSessionHistory(sessionId: string, opts?: { source?: 'streams'; signal?: AbortSignal }): Promise<SessionHistoryResult> {
  const params: Record<string, string> = {};
  if (opts?.source) params.source = opts.source;
  // Remote sessions + fork chains can take 20-30s on first load (SSH pulls 3+ MB JSONL
  // serially through corp proxy). Streams path is local-only and fast; full path may be slow.
  const timeoutMs = opts?.source === 'streams' ? 15_000 : 60_000;
  const res = await apiGet<{ messages: SessionHistoryMessage[]; forkBoundaryIndex?: number }>(
    `/api/sessions/${sessionId}/history`, params, { signal: opts?.signal, timeoutMs },
  );
  return { messages: res.messages, forkBoundaryIndex: res.forkBoundaryIndex };
}

export async function fetchSubagentHistory(
  sessionId: string,
  agentId: string,
  opts?: { workflow?: boolean },
): Promise<{ messages: SessionHistoryMessage[] }> {
  const params = opts?.workflow ? { workflow: '1' } : undefined;
  return apiGet<{ messages: SessionHistoryMessage[] }>(
    `/api/sessions/${sessionId}/subagent/${encodeURIComponent(agentId)}/history`,
    params,
  );
}

/** Persisted dynamic-workflow progress, reconstructed from the on-disk run manifest.
 *  Returns null when the session never ran a workflow (204). Lets the panel survive
 *  page reload after the live in-memory state is gone. */
export async function fetchWorkflowProgress(sessionId: string): Promise<WorkflowProgressSnapshot | null> {
  try {
    // apiGet yields `undefined` on a 204 (no workflow ran) — coalesce to null to honor the signature.
    return (await apiGet<WorkflowProgressSnapshot>(`/api/sessions/${sessionId}/workflow`)) ?? null;
  } catch (err) {
    // A real failure (500 / timeout / malformed JSON) is NOT the same as "no
    // workflow ran" (204 → null above). Don't silently conflate them: warn so a
    // persistent backend bug doesn't masquerade as an empty panel. We still return
    // null because the panel is non-critical and live events can repopulate it.
    log.warn('workflow', 'failed to fetch persisted workflow progress', { sessionId, error: String(err) });
    return null;
  }
}

/** Mirrors the backend SessionBackgroundTasksPayload (web keeps its own copy). */
export interface WorkflowProgressSnapshot {
  sessionId: string;
  workflowName?: string;
  workflowDescription?: string;
  scriptSource?: string;
  inFlight: number;
  tasks: unknown[];
  phases: { index: number; title: string }[];
  agents: {
    agentId: string; index: number; label?: string; phaseIndex?: number; phaseTitle?: string;
    model?: string; status: string; promptPreview?: string; resultPreview?: string;
    tokens?: number; toolCalls?: number; durationMs?: number; startedAt?: number;
  }[];
}

export async function updateSession(sessionId: string, updates: { title?: string; human_note?: string; archived?: boolean; archive_reason?: string; mode?: string }): Promise<SessionRecord> {
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

/**
 * Change a session's reasoning effort. Backend delivers it live via an
 * apply_flag_settings control_request (no respawn) when the CLI is running, then
 * READS BACK the CLI's true effort via get_settings (the ACK alone can't be
 * trusted — the CLI silently overrides via env or downgrades unsupported levels).
 * Always persists the requested level (for cold --resume fallback).
 *
 * Returns:
 *  - `effort`: the requested level (echoed).
 *  - `appliedLive`: the control_request reached a live CLI process.
 *  - `effectiveEffort`: what the CLI ACTUALLY uses now (undefined if not live /
 *    old CLI that can't answer get_settings).
 *  - `overridden`: true when effectiveEffort ≠ requested (env override / downgrade)
 *    — the caller should surface this so the user knows it didn't fully take.
 * Throws on 4xx (invalid level / model can't do it).
 */
export async function setSessionEffort(
  sessionId: string,
  effort: SessionEffort,
): Promise<{ effort: string; appliedLive: boolean; effectiveEffort?: SessionEffort; overridden?: boolean }> {
  return apiPost(`/api/sessions/${sessionId}/effort`, { effort });
}

/**
 * Change a session's model mid-session — same mechanism as setSessionEffort:
 * apply_flag_settings control_request on the live CLI (NO respawn, the running
 * turn is untouched; the NEXT turn uses the new model) + persisted cliModel for
 * cold-resume. Replaces the old empty-message session:send respawn path.
 *
 * Returns:
 *  - `model`: the requested picker alias (echoed, e.g. 'sonnet-1m').
 *  - `cliModel`: the CLI --model value persisted (e.g. 'sonnet[1m]').
 *  - `appliedLive`: the control_request reached a live CLI process.
 *  - `effectiveModel`: the CLI's true runtime model from the get_settings
 *    read-back (undefined if not live / old CLI). Full ID, e.g.
 *    "us.anthropic.claude-sonnet-4-6[1m]".
 * Throws on 4xx (unknown model alias / session not found).
 */
export async function setSessionModel(
  sessionId: string,
  model: string,
): Promise<{ model: string; cliModel: string; appliedLive: boolean; effectiveModel?: string }> {
  return apiPost(`/api/sessions/${sessionId}/model`, { model });
}

/** LIVE runtime settings pulled straight from the CLI (get_settings), paired with
 *  Walnut's requested values. `live:false` ⇒ CLI unreachable; applied is null and
 *  callers should fall back to requested/record values without claiming truth. */
export interface SessionLiveSettings {
  live: boolean;
  requested: { model?: string; effort?: SessionEffort; mode?: string };
  applied: { model: string | null; effort: string | null; mode: string | null } | null;
  /** Present only when fetched with details=true (the picker's collapsed
   *  "Live details" section). Each field degrades to null independently. */
  details?: {
    /** get_context_usage — the CLI's own per-category breakdown (same source as
     *  /context). maxTokens = EFFECTIVE window incl. env clamps. */
    contextUsage: {
      categories: Array<{ name: string; tokens: number }>;
      totalTokens: number | null;
      maxTokens: number | null;
      percentage: number | null;
    } | null;
    /** get_usage → session block: total_cost_usd, model_usage per model, … */
    usage: {
      total_cost_usd?: number;
      total_api_duration_ms?: number;
      total_lines_added?: number;
      total_lines_removed?: number;
      model_usage?: Record<string, {
        inputTokens?: number; outputTokens?: number;
        cacheReadInputTokens?: number; cacheCreationInputTokens?: number;
        costUSD?: number; contextWindow?: number;
      }>;
    } | null;
    binaryVersion: { version?: string; buildTime?: string } | null;
  };
}

export async function fetchSessionLiveSettings(sessionId: string, opts?: { details?: boolean }): Promise<SessionLiveSettings> {
  // details pull waits on the CLI's get_context_usage, which tokenizes the whole
  // tool surface — measured 16s on a large remote session. Give it 60s (server
  // side bounds each read at 45s); the basic pull keeps the default 15s.
  return apiGet(`/api/sessions/${sessionId}/settings${opts?.details ? '?details=1' : ''}`,
    undefined, opts?.details ? { timeoutMs: 60_000 } : undefined);
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
  // Backend waits up to 30s for the new session to start; use 45s client timeout to avoid
  // the frontend timing out before the backend can return an error or success.
  return apiPost(`/api/sessions/${sessionId}/execute`, opts ?? {}, { timeoutMs: 45_000 });
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

// Prefetch working dirs + pre-warm SSH (fire-and-forget). Uses the most-frequent
// path per host (instead of root /) for a useful cache hit.
//
// IMPORTANT: this used to run as a top-level module-import SIDE EFFECT, firing
// fetchWorkingDirs() + a per-host SSH listDirs on EVERY page that imported this
// module — including non-session pages — during the cold-load fan-out, where it
// raced the browser's ~5 HTTP/1.1 lanes against the home critical-path requests.
// It is now an explicit, idempotent call: invoke it when the session-start UI
// actually opens, not at import time.
let _prewarmStarted = false;
export function prewarmWorkingDirs(): void {
  if (_prewarmStarted) return;
  _prewarmStarted = true;
  fetchWorkingDirs().then(dirs => {
    const bestPerHost = new Map<string, string>();
    for (const d of dirs) {
      if (d.host && !bestPerHost.has(d.host)) bestPerHost.set(d.host, d.cwd);
    }
    for (const [host, cwd] of bestPerHost) { listDirs(cwd, host).catch(() => {}); }
  }).catch(() => { _prewarmStarted = false; /* allow retry on next open */ });
}

export interface QuickStartTaskMeta {
  starred?: boolean;
  needs_attention?: boolean;
  priority?: 'immediate' | 'important' | 'backlog' | 'none';
  pinTier?: 'focus' | 'satellite' | 'wait';
}

export async function quickStartSession(opts: {
  cwd: string;
  host?: string;
  message: string;
  category?: string;
  model?: string;
  mode?: string;
  images?: ImageAttachment[];
  taskId?: string; // retry mode: reuse existing task
  taskMeta?: QuickStartTaskMeta;
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

export async function retrySession(sessionId: string): Promise<
  { status: 'reconnected'; sessionId: string } |
  { status: 'resuming'; sessionId: string } |
  { status: 'pending'; taskId: string; oldSessionId: string }
> {
  return apiPost(`/api/sessions/${sessionId}/retry`, {});
}

export async function restartSession(sessionId: string): Promise<
  { status: 'restarted'; sessionId: string }
> {
  return apiPost(`/api/sessions/${sessionId}/restart`, {});
}

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  allow: boolean,
  message?: string,
): Promise<{ status: string; requestId: string; allow: boolean }> {
  return apiPost(`/api/sessions/${sessionId}/permission`, { requestId, allow, message });
}

export async function forkSessionInWalnut(
  sessionId: string,
  opts?: { child_title?: string; message?: string; model?: string; images?: ImageAttachment[] },
): Promise<{ status: string; sourceSessionId: string; taskId: string; childTaskCreated?: boolean }> {
  const { images, ...rest } = opts ?? {};
  const body: Record<string, unknown> = { create_child_task: true, ...rest };
  // Convert ImageAttachment[] → backend ImagePayload (data + mediaType only).
  if (images?.length) {
    body.images = images.map(img => ({ data: img.data, mediaType: img.mediaType }));
  }
  return apiPost(`/api/sessions/${sessionId}/fork`, body);
}

// ── Forensic Observability ──

/** Minimal incident shape the UI needs back from the Investigate button. */
export interface Incident {
  id: string;
  sessionId: string;
  taskId?: string;
  trigger: 'invariant' | 'manual' | 'canary';
  label: string;
  summary: string;
  severity: 'warn' | 'error';
  status: 'open' | 'investigating' | 'resolved' | 'dismissed';
  bundlePath?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Investigate a session — freezes an all-layer evidence bundle and opens a
 * manual incident. `sessionId` is the claudeSessionId; pass the linked taskId
 * when available so the incident is filed against the right task.
 */
export async function investigateSession(
  sessionId: string,
  taskId?: string,
): Promise<{ incident: Incident }> {
  return apiPost('/api/incidents/investigate', { sessionId, ...(taskId ? { taskId } : {}) });
}
