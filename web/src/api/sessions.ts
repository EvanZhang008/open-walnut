import { apiGet, apiPatch, apiPost, ApiError } from './client';
import type { SessionSummary, SessionRecord, SessionEffort, SessionModelCatalogEntry, SessionEngine } from '@open-walnut/core';
import type { ImageAttachment } from './chat';
import type { SessionHistoryMessage } from '@/types/session';
import { log } from '@/utils/log';
import { isPlaceholderColumnId } from '@/utils/column-ids';
import { recordFinishedAgentIds } from '@/cache/finished-agents-store';
import {
  seedSessionStatus,
  seedTaskSessionStatuses,
  sessionStatusStore,
} from '@/stores/session-status-store';
import { registerSessionTitle } from '@/stores/entity-label-store';
import { getEngineCatalog } from '@/hooks/useEngineCatalog';
import { engineEntry, type LaunchEngine, type LaunchMemory } from '@/utils/engines';

/** Opportunistic <session-ref/> pill-title seeding: there is no client-side
 *  all-sessions store, so any fetched record's title is registered here and
 *  unresolved pills keep their label fallback. */
function seedSessionTitle(session: { claudeSessionId?: string; title?: string } | null | undefined): void {
  if (session?.claudeSessionId) registerSessionTitle(session.claudeSessionId, session.title);
}

export async function fetchSessions(): Promise<SessionSummary[]> {
  const res = await apiGet<{ sessions: SessionSummary[] }>('/api/sessions');
  for (const session of res.sessions) seedSessionStatus(session, 'rest:session-list');
  return res.sessions;
}

export async function fetchRecentSessions(limit?: number): Promise<SessionSummary[]> {
  const params = limit ? { limit: String(limit) } : undefined;
  const res = await apiGet<{ sessions: SessionSummary[] }>('/api/sessions/recent', params);
  for (const session of res.sessions) seedSessionStatus(session, 'rest:session-list');
  return res.sessions;
}

/** Server-side session search (title / task title / cwd / host) over the FULL
 *  list — the client never holds all sessions, so filtering happens in the
 *  /recent route's ?q= handler. Empty q = plain recent list. */
export async function searchSessions(q: string, limit = 30): Promise<SessionRecord[]> {
  const params: Record<string, string> = { limit: String(limit) };
  if (q.trim()) params.q = q.trim();
  const res = await apiGet<{ sessions: SessionRecord[] }>('/api/sessions/recent', params);
  for (const session of res.sessions) {
    seedSessionStatus(session, 'rest:session-list');
    seedSessionTitle(session);
  }
  return res.sessions;
}

export async function fetchSessionSummaries(limit?: number): Promise<SessionSummary[]> {
  const params = limit ? { limit: String(limit) } : undefined;
  const res = await apiGet<{ summaries: SessionSummary[] }>('/api/sessions/summaries', params);
  return res.summaries;
}

const STATUS_HYDRATION_BATCH_SIZE = 100;

export async function hydrateSessionStatuses(sessionIds: Iterable<string>): Promise<void> {
  const uniqueIds = [...new Set(sessionIds)]
    .filter((sessionId) => sessionId && !isPlaceholderColumnId(sessionId));
  for (let index = 0; index < uniqueIds.length; index += STATUS_HYDRATION_BATCH_SIZE) {
    const ids = uniqueIds.slice(index, index + STATUS_HYDRATION_BATCH_SIZE);
    try {
      const res = await apiGet<{ statuses: Record<string, unknown> }>(
        '/api/sessions/status',
        { ids: ids.join(',') },
      );
      for (const snapshot of Object.values(res.statuses ?? {})) {
        sessionStatusStore.applyVersioned(snapshot, 'rest:session-list');
      }
    } catch (error) {
      // Mixed-version servers may not expose the hydration endpoint yet. The
      // task payload's legacy status remains available as a fallback.
      log.warn('session-status', 'task status hydration failed', {
        sessionIds: ids,
        error: String(error),
      });
    }
  }
}

// Re-export from canonical types
export type { SessionHistoryMessage } from '@/types/session';

export interface SessionHistoryResult {
  messages: SessionHistoryMessage[];
  /** Prefix rows whose CONTENT changed after we synced them — upsert by msgId, do
   *  NOT append. An Agent/Task row gains `bgTaskFinished` from a task-notification
   *  the CLI writes long after the row itself (74s in the measured incident), and a
   *  tool row gains its `result` late. Without applying these, the client's prefix
   *  is frozen mid-flight and the agent's lane blocks never get absorption proof —
   *  a phantom Agent box sits at the bottom of the timeline (inc-1785965937858). */
  revisedMessages?: SessionHistoryMessage[];
  forkBoundaryIndex?: number;
  /** Orphan finished-agent toolUseIds (inc-1786496042099): nested background
   *  agents proven STOPPED by a canonical <task-notification>, whose tool_use
   *  row never reaches the canonical JSONL (it exists only in the daemon
   *  stream) — so no history row can ever carry the id. Rides OUTSIDE the
   *  messages array (cursor space unchanged); the render filter counts these
   *  as finished-parent lane evidence. Omitted when empty. */
  finishedAgentIds?: string[];
  /** Combined-message count at the source of truth = the cursor for the NEXT delta fetch. */
  cursor?: number;
  /** True when `messages` is an incremental slice (since was honored); false/undefined = full payload. */
  delta?: boolean;
  /** True when the live read failed and the server served its last good parse
   *  (SSH down / daemon timeout). Render it, but show a degraded banner and do
   *  NOT advance the delta cursor off it. */
  stale?: boolean;
  /** Human-readable reason for `stale` (the underlying read error). */
  staleReason?: string;
  /** Set when session exists but history file is unavailable (remote unreachable, file deleted). */
  historyUnavailable?: string;
  /** True when the payload came from a BOUNDED window read (whale transcript /
   *  cold tail-bounded read): `total` is the window length, not the source's
   *  message count, so olderHidden can't be computed from it — but older
   *  messages DO exist; show an uncounted "Load earlier" affordance. */
  windowed?: boolean;
  /** The session's TRUE first user message (server computes it from the full
   *  parse before tail-slicing). The pinned "Initial Prompt" bubble must use
   *  this, never the head of the tail-sliced window. Absent on deltas and on
   *  windowed/degraded payloads where the server doesn't hold the real head. */
  initialUserText?: string;
  /** Message count at the SOURCE (before any `?tail=` slice). Lets a payload
   *  that carries no `cursor` (the Phase-1 streams read) still tell the UI that
   *  older messages exist, so the "Load earlier" affordance and the pinned
   *  initial prompt render in the FIRST paint instead of appearing above the
   *  reader a second later and shoving the conversation down. */
  total?: number;
}

/** Lazy history: first load fetches only the last N messages (server `?tail=`).
 *  Older messages backfill on demand ("Show earlier" past what we hold). */
export const HISTORY_TAIL_LIMIT = 400;

// ── Identical-request coalescing ─────────────────────────────────────────────
// The same history request routinely fires more than once at the same moment:
// SessionPanel and SessionChatHistory each mount a useSessionHistory for the
// SAME session (two full fetches per open), and a turn's batch-completed
// triggers both the hook's delta and session-cache's background delta (two
// identical ?since= requests, observed as pairs in the prod log). One in-flight
// request per exact shape serves every concurrent caller. The underlying fetch
// aborts only when EVERY subscriber has aborted — an aborted subscriber simply
// stops caring (callers already guard with `cancelled` flags), it must not
// kill the request for the others.
interface InflightHistory {
  promise: Promise<SessionHistoryResult>;
  subscribers: number;
  controller: AbortController;
}
const inflightHistory = new Map<string, InflightHistory>();

export async function fetchSessionHistory(
  sessionId: string,
  opts?: {
    source?: 'streams'; signal?: AbortSignal; since?: number;
    /** Identity of the newest uniquely-identified message we hold (+ rows after it).
     *  The server slices after THAT message rather than after `since` messages —
     *  see web/src/hooks/history-anchor.ts. */
    anchorMsgId?: string; anchorTail?: number;
    /** msgIds we hold an UNSETTLED copy of and want re-served (see collectUnsettledIds). */
    reviseIds?: string[];
    /** Lazy load: only the last N messages (server-side slice — the response's
     *  `cursor`/`total` stay in the FULL count space, so deltas keep working).
     *  A whale session (3000+ msgs) shrinks from a multi-MB transfer + a 25s
     *  render freeze to a ~100KB tail. */
    tail?: number;
  },
): Promise<SessionHistoryResult> {
  const params: Record<string, string> = {};
  if (opts?.source) params.source = opts.source;
  if (opts?.tail !== undefined && Number.isFinite(opts.tail)) params.tail = String(opts.tail);
  // Delta mode: ask only for messages after the client's cursor. Server returns a
  // small slice (usually 1-5 messages) + the new cursor. Empty slice = archive
  // hasn't caught up yet (turn not flushed); caller keeps streaming blocks & retries.
  if (opts?.since !== undefined) params.since = String(opts.since);
  if (opts?.anchorMsgId) {
    params.anchorMsgId = opts.anchorMsgId;
    params.anchorTail = String(opts.anchorTail ?? 0);
  }
  if (opts?.reviseIds && opts.reviseIds.length > 0) params.revise = opts.reviseIds.join(',');

  const key = `${sessionId}?${new URLSearchParams(params).toString()}`;
  let entry = inflightHistory.get(key);
  if (!entry) {
    const controller = new AbortController();
    const created: InflightHistory = {
      controller,
      subscribers: 0,
      promise: undefined as unknown as Promise<SessionHistoryResult>,
    };
    // Identity-guarded settle-delete: the eager delete-on-abort below means a
    // SUCCESSOR entry can occupy this key before this promise settles — an
    // unconditional delete here would evict that live successor and break
    // coalescing for every caller after it (duplicate whale fetches).
    created.promise = fetchSessionHistoryRaw(sessionId, params, opts?.source, opts?.tail, controller.signal)
      .finally(() => { if (inflightHistory.get(key) === created) inflightHistory.delete(key); });
    inflightHistory.set(key, created);
    entry = created;
  }
  const live = entry;
  live.subscribers++;
  const onAbort = () => {
    live.subscribers--;
    if (live.subscribers <= 0) {
      // Drop the entry BEFORE aborting: the .finally delete only runs on settle,
      // and a remount inside that window would adopt the rejected promise and
      // surface a spurious "signal is aborted" error (fast thread-chip switching).
      if (inflightHistory.get(key) === live) inflightHistory.delete(key);
      live.controller.abort();
    }
  };
  if (opts?.signal) {
    if (opts.signal.aborted) { onAbort(); }
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  return live.promise;
}

async function fetchSessionHistoryRaw(
  sessionId: string,
  params: Record<string, string>,
  source: 'streams' | undefined,
  tail: number | undefined,
  signal: AbortSignal,
): Promise<SessionHistoryResult> {
  // Remote sessions + fork chains can take 20-30s on first load (SSH pulls 3+ MB JSONL
  // serially through a corporate proxy). Streams path is local-only and fast; full path may be
  // slow — and a WHALE session (>10MB JSONL, chunked fs.readRange server-side, 120s
  // server ceiling) legitimately exceeds the old 60s; aborting client-side just wasted
  // the transfer and re-requested from zero (inc-1783532915925). Tail-sliced requests
  // get a tighter ceiling: the response is bounded, and one unbounded fetch pinning a
  // browser lane for 150s starves everything else on the shared 6-connection pool
  // (that is how STT "timed out" while the server was idle — 2026-08-11).
  const timeoutMs = source === 'streams' ? 15_000 : (tail ? 60_000 : 150_000);
  const res = await apiGet<{
    messages: SessionHistoryMessage[];
    revisedMessages?: SessionHistoryMessage[];
    forkBoundaryIndex?: number;
    finishedAgentIds?: string[];
    cursor?: number;
    delta?: boolean;
    stale?: boolean;
    staleReason?: string;
    historyUnavailable?: string;
    windowed?: boolean;
    initialUserText?: string;
    total?: number;
  }>(
    `/api/sessions/${sessionId}/history`, params, { signal, timeoutMs },
  );
  if (res.historyUnavailable) {
    throw new Error(`HISTORY_UNAVAILABLE:${res.historyUnavailable}`);
  }
  // Flight-record what THIS client received (request shape + response shape,
  // no content) — the replay input for the chat lab when a tripwire fires.
  try {
    const { recordFlight } = await import('@/stream/flight-recorder');
    recordFlight(sessionId, 'history:fetch', {
      since: params.since !== undefined ? Number(params.since) : undefined,
      anchor: params.anchorMsgId,
      revise: params.revise ? params.revise.split(',').length : 0,
      delta: res.delta ?? false, got: res.messages.length,
      revised: res.revisedMessages?.length ?? 0, cursor: res.cursor,
    });
  } catch { /* recorder is diagnostics-only — never block the fetch */ }
  // Union orphan finished-agent ids into the per-session store — the ONE choke
  // point every history consumer flows through (useSessionHistory, the
  // session-cache background refresh, the stale retry loop), so nested-agent
  // absorption proof reaches the render filter no matter which path fetched.
  recordFinishedAgentIds(sessionId, res.finishedAgentIds);
  return {
    messages: res.messages,
    revisedMessages: res.revisedMessages,
    forkBoundaryIndex: res.forkBoundaryIndex,
    finishedAgentIds: res.finishedAgentIds,
    cursor: res.cursor,
    delta: res.delta,
    stale: res.stale,
    staleReason: res.staleReason,
    windowed: res.windowed,
    initialUserText: res.initialUserText,
    total: res.total,
  };
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

export async function updateSession(sessionId: string, updates: { title?: string; human_note?: string; archived?: boolean; archive_reason?: string; mode?: string; output_mode?: import('@open-walnut/core').SessionOutputMode; pinned_messages?: import('@/types/session').SessionPinnedMessage[] }): Promise<SessionRecord> {
  const res = await apiPatch<{ session: SessionRecord }>(`/api/sessions/${sessionId}`, updates);
  seedSessionStatus(res.session, 'rest:session');
  seedSessionTitle(res.session);
  return res.session;
}

export async function fetchSessionsForTask(taskId: string): Promise<SessionRecord[]> {
  const res = await apiGet<{ sessions: SessionRecord[] }>(`/api/sessions/task/${taskId}`);
  for (const session of res.sessions) {
    seedSessionStatus(session, 'rest:session-list');
    seedSessionTitle(session);
  }
  return res.sessions;
}

/**
 * Fetch one session record. Returns null ONLY when the session genuinely does
 * not exist (404). Any other failure (network, timeout, empty-body parse error)
 * THROWS — callers must not treat a transient fetch failure as "session gone".
 * The old blanket `catch { return null }` turned a browser-cache 304 race into
 * "Untitled session" panels (inc-1784686852150 / inc-1784752220440).
 */
export async function fetchSession(sessionId: string): Promise<SessionRecord | null> {
  try {
    const res = await apiGet<{ session: SessionRecord }>(`/api/sessions/${sessionId}`);
    seedSessionStatus(res.session, 'rest:session');
    seedSessionTitle(res.session);
    return res.session;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    log.warn('session', 'fetchSession failed (transient — NOT treating as missing)', {
      sessionId,
      error: String(err),
    });
    throw err;
  }
}

export async function fetchSessionVscodeUri(sessionId: string): Promise<string> {
  const res = await apiGet<{ uri: string }>(`/api/sessions/${sessionId}/vscode-uri`);
  return res.uri;
}

export interface VscodeEmbedInfo {
  /** Browser-loadable URL (127.0.0.1 — local code-server or the SSH tunnel end). */
  url: string;
  /** Instance identity — changes when code-server restarts (stale-iframe detection). */
  token: string;
  open: { kind: 'workspace' | 'folder'; path: string };
  host: string;
  codeServerVersion?: string;
}

/**
 * Ensure a code-server exists for this session's host and return the iframe
 * URL. First call on a host may download ~100MB (install), so the timeout is
 * generous; pass install=false to probe without installing.
 */
export async function ensureSessionVscodeEmbed(sessionId: string, opts?: { install?: boolean }): Promise<VscodeEmbedInfo> {
  const qs = opts?.install === false ? '?install=false' : '';
  return apiPost<VscodeEmbedInfo>(`/api/sessions/${sessionId}/vscode-embed${qs}`, {}, { timeoutMs: 150_000 });
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

/** A model row an ACP provider advertised at session start. */
export interface CodexModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

/** The per-session ACP model catalog. Engine-generic on the server (it asks
 *  whichever ACP provider backs the session), so every ACP engine reads it. */
export async function fetchCodexModelCatalog(
  sessionId: string,
): Promise<{ models: CodexModelInfo[]; currentModelId?: string; source: 'acp' }> {
  return apiGet(`/api/sessions/${sessionId}/model-catalog`);
}

export async function setCodexSessionModel(
  sessionId: string,
  model: string,
): Promise<{ applied: true; model: string }> {
  return apiPost(`/api/sessions/${sessionId}/model`, { model });
}

/** The ENGINE's model catalog for a DRAFT (no session exists yet): the server
 *  runs a cached one-shot adapter probe. 502 (adapter not answering — missing
 *  credentials / not installed) rejects with the adapter's own words. */
export async function fetchEngineModelCatalog(
  engine: string,
  cwd?: string,
  opts?: { refresh?: boolean; timeoutMs?: number },
): Promise<{ engine: string; models: CodexModelInfo[]; currentModelId?: string; source: 'probe' | 'mock' }> {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  // Retry after a probe failure: busts the server's cached failure entry.
  if (opts?.refresh) params.set('refresh', '1');
  const qs = params.toString();
  // 20s default: must OUTLIVE the server's 15s probe deadline — with the
  // browser's default 15s the fetch aborts ("signal timed out") right as the
  // server is composing its honest error (or its answer), and the picker
  // loses the adapter's words. Prefetch callers pass a SHORT timeout instead:
  // aborting client-side frees the connection slot while the server-side
  // probe runs on and still lands in the cache.
  return apiGet(`/api/engines/${encodeURIComponent(engine)}/models${qs ? `?${qs}` : ''}`, undefined, { timeoutMs: opts?.timeoutMs ?? 20_000 });
}

export interface SessionControlOption {
  value: string;
  name: string;
  description?: string;
}

export interface SessionControl {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: 'select';
  currentValue: string;
  options: SessionControlOption[];
}

export interface SessionControlsResponse {
  engine: SessionEngine;
  controls: SessionControl[];
}

export async function fetchSessionControls(sessionId: string): Promise<SessionControlsResponse> {
  return apiGet(`/api/sessions/${sessionId}/controls`);
}

export async function postSessionControl(
  sessionId: string,
  id: string,
  value: string,
): Promise<SessionControlsResponse> {
  return apiPost(`/api/sessions/${sessionId}/controls`, { id, value });
}

/** LIVE runtime settings pulled straight from the CLI (get_settings), paired with
 *  Walnut's requested values. `live:false` ⇒ CLI unreachable; applied is null and
 *  callers should fall back to requested/record values without claiming truth. */
export interface SessionLiveSettings {
  live: boolean;
  requested: { model?: string; effort?: SessionEffort; mode?: string };
  applied: { model: string | null; effort: string | null; mode: string | null } | null;
  effective: { effortLevel: SessionEffort | null } | null;
  /** Present only when fetched with details=true (the picker's collapsed
   *  "Live details" section). Each field degrades to null independently. */
  details?: {
    /** get_context_usage — the CLI's own per-category breakdown (same source as
     *  /context). NB maxTokens is the AUTO-COMPACT window (env clamps applied),
     *  NOT the model's max, and in 2.1.240 rawMaxTokens is literally the same
     *  variable. Use `windows.modelMax` for the denominator the badge shows. */
    contextUsage: {
      categories: Array<{ name: string; tokens: number }>;
      totalTokens: number | null;
      maxTokens: number | null;
      percentage: number | null;
      /** The model's window before the auto-compact clamp (CLI 2.1.2xx+). */
      rawMaxTokens?: number | null;
      /** 'env' | 'settings' | 'clientdata' | 'model-default' — what set the
       *  window. Shown in the panel so a surprising denominator explains
       *  itself instead of looking like a Walnut miscount. */
      autocompactSource?: string | null;
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
    /** The windows Walnut resolved: `modelMax` is the context% denominator (the
     *  model's absolute max), `autoCompactAt` is where this session compacts
     *  when a setting puts that below the model's limit. */
    windows?: { modelMax: number | null; autoCompactAt: number | null } | null;
  };
}

export async function fetchSessionLiveSettings(sessionId: string, opts?: { details?: boolean }): Promise<SessionLiveSettings> {
  // details pull waits on the CLI's get_context_usage, which tokenizes the whole
  // tool surface — measured 16s on a large remote session. Give it 60s (server
  // side bounds each read at 45s); the basic pull keeps the default 15s.
  return apiGet(`/api/sessions/${sessionId}/settings${opts?.details ? '?details=1' : ''}`,
    undefined, opts?.details ? { timeoutMs: 60_000 } : undefined);
}

/** The session's TRUE selectable model catalog (GET /:id/models).
 *  source:'cli'      → rows straight from the CLI's initialize response (values
 *                      are full provider IDs — send them verbatim to setSessionModel).
 *  source:'fallback' → static SESSION_MODELS registry in catalog shape (values
 *                      are legacy alias ids) — old CLI or unreachable session. */
export interface SessionModelCatalog {
  source: 'cli' | 'fallback';
  live: boolean;
  models: SessionModelCatalogEntry[];
  fetchedAt?: string;
}

export async function fetchSessionModelCatalog(
  sessionId: string,
  opts?: { refresh?: boolean },
): Promise<SessionModelCatalog> {
  // Server bounds the CLI initialize read at 10s (it can queue behind a heavy
  // get_context_usage on the CLI's serial control loop) — give the HTTP call 15s.
  return apiGet(`/api/sessions/${sessionId}/models${opts?.refresh ? '?refresh=1' : ''}`,
    undefined, { timeoutMs: 15_000 });
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
  /** Majority-vote project for this dir, or the configured default. '' = Inbox. */
  project: string;
  count: number;
  lastUsed: string;
  /** Launch config remembered from the last Quick Start on this dir. `model`
   *  is the raw picker value (catalog ID or legacy alias). Absent = Auto/Claude. */
  lastLaunch?: LaunchMemory;
}

/** A host from config.hosts — shown as a launcher tab even with zero session history. */
export interface ConfiguredHost {
  alias: string;
  label: string;
  /** True for auto-discovered FQDN-only entries with no human-chosen alias —
   *  the launcher shows a "name this host" nudge for these. */
  rawName?: boolean;
}

export interface WorkingDirsResult {
  dirs: WorkingDirEntry[];
  /** All configured remote hosts (may be absent on older servers). */
  hosts: ConfiguredHost[];
}

// Cache working dirs so /session popover opens instantly (prefetched on page load)
let _workingDirsCache: WorkingDirsResult | null = null;
let _workingDirsFetching: Promise<WorkingDirsResult> | null = null;

export async function fetchWorkingDirs(): Promise<WorkingDirsResult> {
  if (_workingDirsCache) return _workingDirsCache;
  if (_workingDirsFetching) return _workingDirsFetching;
  _workingDirsFetching = apiGet<{ dirs: WorkingDirEntry[]; hosts?: ConfiguredHost[] }>('/api/sessions/working-dirs')
    .then(res => {
      const result: WorkingDirsResult = { dirs: res.dirs, hosts: res.hosts ?? [] };
      _workingDirsCache = result;
      _workingDirsFetching = null;
      return result;
    })
    .catch(err => { _workingDirsFetching = null; throw err; });
  return _workingDirsFetching;
}

/** Invalidate cache (e.g. after starting a new session) */
export function invalidateWorkingDirsCache(): void { _workingDirsCache = null; _workingDirsFetching = null; }

/**
 * SYNCHRONOUS peek at the working-dirs cache — `null` until a fetch has landed.
 *
 * For render paths that are contractually network-free (the draft session
 * column's recent-folder chips + its per-directory launch memory): they show
 * what is already known and simply render nothing when the cache is cold. Never
 * triggers a request — callers that want the data warm must have called
 * `fetchWorkingDirs()` earlier (MainPage prefetches once on mount).
 */
export function peekWorkingDirs(): WorkingDirsResult | null { return _workingDirsCache; }

export interface DirListing {
  dirs: string[];
  parent: string;
  /** false = the listed directory itself doesn't exist (still HTTP 200). */
  exists: boolean;
}

export async function listDirs(prefix: string, host?: string | null, opts?: { signal?: AbortSignal }): Promise<DirListing> {
  const params = new URLSearchParams({ prefix });
  if (host) params.set('host', host);
  const res = await apiGet<{ dirs: string[]; parent: string; exists?: boolean }>(
    `/api/sessions/list-dirs?${params}`, undefined, opts,
  );
  // Tolerate old servers that don't send `exists` (mixed-version window)
  return { dirs: res.dirs, parent: res.parent, exists: res.exists ?? true };
}

// Client-side listing cache — survives popover close/reopen (module-level, 30s TTL).
// Keyed by host + the RESOLVED parent dir from the server (~ already expanded).
const _liveDirCache = new Map<string, { listing: DirListing; ts: number }>();
const LIVE_DIR_CACHE_TTL = 30_000;

function liveDirCacheKey(host: string | null | undefined, parent: string): string {
  return `${host ?? '__local__'}::${parent}`;
}

/** Cached listDirs. Serves from cache when the request's parent dir was fetched <30s ago. */
export async function listDirsCached(prefix: string, host?: string | null, opts?: { signal?: AbortSignal }): Promise<DirListing> {
  // Request-side key uses the raw parent-of-prefix; on response we also store
  // under the server-resolved parent so `~`-prefixed requests hit next time.
  const rawParent = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1);
  const key = liveDirCacheKey(host, rawParent);
  const hit = _liveDirCache.get(key);
  if (hit && Date.now() - hit.ts < LIVE_DIR_CACHE_TTL) return hit.listing;
  const listing = await listDirs(prefix, host, opts);
  const entry = { listing, ts: Date.now() };
  _liveDirCache.set(key, entry);
  const resolvedKey = liveDirCacheKey(host, listing.parent.endsWith('/') ? listing.parent : listing.parent + '/');
  if (resolvedKey !== key) _liveDirCache.set(resolvedKey, entry);
  return listing;
}

/** Drop the live-dir cache (e.g. after creating a directory). */
export function invalidateLiveDirCache(): void { _liveDirCache.clear(); }

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
  fetchWorkingDirs().then(({ dirs, hosts }) => {
    const bestPerHost = new Map<string, string>();
    for (const d of dirs) {
      if (d.host && !bestPerHost.has(d.host)) bestPerHost.set(d.host, d.cwd);
    }
    // Configured hosts with no history yet still get a pre-warm (from ~) so the
    // first live browse on a fresh host isn't a cold SSH connect.
    for (const h of hosts) {
      if (!bestPerHost.has(h.alias)) bestPerHost.set(h.alias, '~/');
    }
    for (const [host, cwd] of bestPerHost) { listDirs(cwd, host).catch(() => {}); }
  }).catch(() => { _prewarmStarted = false; /* allow retry on next open */ });
}

export interface QuickStartTaskMeta {
  /** Start the new task already marked unread. */
  unread?: boolean;
  priority?: 'immediate' | 'important' | 'backlog' | 'none';
  /** Tier to pin the new task to — a built-in name or a custom tier id (`ct_*`).
   *  `null` = explicitly DON'T pin — distinct from omitted, which lets the server
   *  apply its own default (fix-walnut → Satellite, the same launcher baseline as
   *  a regular quick session). */
  pinTier?: string | null;
  /** Task dates (ISO) — the same trio POST /api/tasks takes; a launch IS a task
   *  create. Snake_case to match the task wire format. */
  due_date?: string;
  start_date?: string;
  end_date?: string;
}

export async function quickStartSession(opts: {
  cwd: string;
  host?: string;
  message: string;
  model?: string;
  mode?: string;
  images?: ImageAttachment[];
  taskId?: string; // retry mode: reuse existing task
  taskMeta?: QuickStartTaskMeta;
  /** File the new task under this project (created if unknown). Omitted = Inbox / server default. */
  project?: string;
  /** `project` was derived from the picked folder — a NEWLY created project row
   *  gets that folder stamped as its default_cwd (folder→project memory). */
  projectFromFolder?: boolean;
  /** Launch intent — 'fix-walnut' makes the server wrap the message in a repair briefing. */
  intent?: 'fix-walnut';
  /** "Ask Walnut" launch: the session spawns with the Personal AI profile; the
   *  server owns the cwd (send ''), files the task under project 'Ask Walnut' and
   *  defaults the tier to Focus. Native (claude) engine only. */
  walnutAgent?: boolean;
  /** User opted into "create & start": server mkdirs the cwd before starting. */
  createCwd?: boolean;
  /** Coding-agent engine. undefined = the default engine; any other value is an
   *  explicitly picked engine (all ACP-backed and local-only today). */
  engine?: LaunchEngine;
  /** `sessionId` is present when the engine takes a preassigned id; an engine
   *  whose provider issues its own id (every ACP engine) omits it. */
}): Promise<{ taskId: string; task: unknown; sessionId?: string }> {
  // Convert ImageAttachment[] to the backend ImagePayload format (data + mediaType only)
  const payload: Record<string, unknown> = { ...opts };
  if (opts.images?.length) {
    payload.images = opts.images.map(img => ({ data: img.data, mediaType: img.mediaType }));
  } else {
    delete payload.images;
  }
  // CLIENT-OWNED session id — only for an engine whose id walnut may preassign
  // (the catalog's idProvisioning; an ACP provider issues its own). The server
  // honors it as the preassigned id, which makes the launch reconcilable even if
  // this HTTP response never arrives: the caller can poll GET /api/sessions/<id>
  // instead of being stuck on a placeholder. This is the root fix for the
  // false-"Failed"-then-duplicate-on-Retry incident (2026-08-03: server 200 in
  // 2.7s, browser AbortSignal fired at 15s under main-thread jam).
  const preassignsId = engineEntry(getEngineCatalog(), opts.engine)
    .capabilities.idProvisioning === 'preassigned';
  const clientSessionId = preassignsId && typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID() : undefined;
  if (clientSessionId) payload.sessionId = clientSessionId;
  // 60s, not the 15s default: quick-start spawns a real CLI process (slow under
  // load) AND creates durable state (task + session) — it must not share the
  // lightweight-GET timeout budget.
  try {
    const result = await apiPost<{ taskId: string; task: unknown; sessionId?: string }>('/api/sessions/quick-start', payload, { timeoutMs: 60_000 });
    seedTaskSessionStatuses(result.task, 'rest:task');
    invalidateWorkingDirsCache(); // new session → new path entry
    if (opts.createCwd) invalidateLiveDirCache(); // the dir now exists — stale "missing" entries lie
    return result;
  } catch (err) {
    // Timeout with a client-owned id = UNKNOWN outcome, not failure. The server
    // may well have started the session; reconcile by id before giving up so the
    // pending panel resolves to the live session instead of a false "Failed".
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
    if (isTimeout && clientSessionId) {
      const recovered = await reconcileQuickStart(clientSessionId);
      if (recovered) return recovered;
    }
    throw err;
  }
}

/** After a quick-start response was lost (client timeout), check whether the
 *  server actually created the session. A few short polls cover the case where
 *  the POST is still mid-flight server-side when our timeout fired. */
async function reconcileQuickStart(sessionId: string): Promise<{ taskId: string; task: unknown; sessionId: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    try {
      // Response envelope: { session: { taskId }, pendingPermissions }.
      const res = await apiGet<{ session?: { taskId?: string } }>(`/api/sessions/${sessionId}`, undefined, { timeoutMs: 10_000 });
      const taskId = res?.session?.taskId;
      if (taskId) {
        log.info('sessions', 'quick-start response lost but session exists — reconciled by client id', { sessionId, taskId });
        const task = await apiGet<unknown>(`/api/tasks/${taskId}`, undefined, { timeoutMs: 10_000 }).catch(() => null);
        if (task) seedTaskSessionStatuses(task, 'rest:task');
        invalidateWorkingDirsCache();
        return { taskId, task, sessionId };
      }
    } catch { /* not there (yet) — retry */ }
  }
  return null;
}

/** Reconnect a failed session. NEVER sends message text: 'resuming' means the
 *  user's own queued message was re-sent, 'resumable' means the record was
 *  cleared and typing is what resumes the work, 'pending' is the archive+new
 *  fallback for a conversation that never reached disk. */
export async function retrySession(sessionId: string): Promise<
  { status: 'reconnected'; sessionId: string } |
  { status: 'resumable'; sessionId: string } |
  { status: 'resuming'; sessionId: string } |
  { status: 'pending'; taskId: string; oldSessionId: string }
> {
  return apiPost(`/api/sessions/${sessionId}/retry`, {});
}

/** Mirrors RecheckResult in src/core/sessions/session-lifecycle.ts. */
export interface SessionRecheck {
  sessionId: string;
  checked: boolean;
  reachable: boolean;
  alive?: boolean;
  processStatus: 'running' | 'idle' | 'stopped' | 'error';
  /** The recorded cause is structurally an infra claim (server-side
   *  classification — the client never pattern-matches error prose). */
  infraClaim: boolean;
  reason?: 'terminal_error' | 'archived' | 'no_pooled_connection' | 'timeout'
    | 'rpc_failed' | 'no_snapshot';
}

/** Ask the server to re-check this session against its host NOW and reconcile
 *  the record from the daemon's snapshot. Sends nothing to the session. The
 *  server bounds its own daemon RPC, so this is a short request by construction. */
export async function recheckSession(sessionId: string): Promise<SessionRecheck> {
  return apiPost(`/api/sessions/${sessionId}/recheck`, {}, { timeoutMs: 10_000 });
}

export async function restartSession(sessionId: string): Promise<
  { status: 'restarted'; sessionId: string; pendingMessages?: number }
> {
  return apiPost(`/api/sessions/${sessionId}/restart`, {});
}

/** Terminate a session — closes the CLI process (no respawn) and marks it stopped.
 *  A session that owns recurring CLI crons is refused with 409 `cron_owner`
 *  unless `force` — the crons would silently migrate to another session in the
 *  same project directory (directory-scoped scheduler lock). */
export async function terminateSession(sessionId: string, opts?: { force?: boolean }): Promise<
  { status: 'terminated'; sessionId: string }
> {
  return apiPost(`/api/sessions/${sessionId}/terminate`, { force: opts?.force === true });
}

/** Answer a live CLI permission prompt.
 *  `answers` is AskUserQuestion-only: question text → the chosen option label (or
 *  the user's free-text). The server merges it into the tool's `answers` input, so
 *  the model receives the real answers instead of an empty set. */
export async function respondToPermission(
  sessionId: string,
  requestId: string,
  allow: boolean,
  message?: string,
  optionId?: string,
  answers?: Record<string, string>,
): Promise<{ status: string; requestId: string; allow: boolean }> {
  return apiPost(`/api/sessions/${sessionId}/permission`, { requestId, allow, message, optionId, answers });
}

export async function forkSessionInWalnut(
  sessionId: string,
  opts?: { child_title?: string; message?: string; model?: string; images?: ImageAttachment[] },
): Promise<{ status: string; sourceSessionId: string; sessionId: string; taskId: string; childTaskCreated?: boolean }> {
  const { images, ...rest } = opts ?? {};
  const body: Record<string, unknown> = { create_child_task: true, ...rest };
  // Convert ImageAttachment[] → backend ImagePayload (data + mediaType only).
  if (images?.length) {
    body.images = images.map(img => ({ data: img.data, mediaType: img.mediaType }));
  }
  return apiPost(`/api/sessions/${sessionId}/fork`, body);
}

// ── Rewind ──

/** What a rewind WOULD do (server dry run). Mirrors RewindPreview in
 *  src/core/sessions/session-rewind.ts. */
export interface RewindPreview {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  messageUuid: string;
  messageLabel?: string;
  droppedMessages: number;
  filesUnavailableReason?: 'session_not_live' | 'engine_unsupported';
}

export interface RewindResult {
  status: 'rewound';
  /** 'in-place' rewound THIS session (sessionId === sourceSessionId); 'fork'
   *  continued under a new id. Absent on servers older than the field. */
  mode?: 'in-place' | 'fork';
  sourceSessionId: string;
  sessionId: string;
  taskId?: string;
  title: string;
  host?: string;
  files?: { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number; skippedReason?: string };
  sourceArchived: boolean;
}

/** Dry run — shows the blast radius, changes nothing. */
export async function previewRewind(sessionId: string, messageUuid: string): Promise<RewindPreview> {
  const res = await apiPost<{ preview: RewindPreview }>(`/api/sessions/${sessionId}/rewind`, {
    message_uuid: messageUuid, dry_run: true,
  });
  return res.preview;
}

/** Commit the rewind: optional file restore, then a rewound continuation session. */
export async function rewindSession(
  sessionId: string,
  messageUuid: string,
  opts?: { mode?: 'in-place' | 'fork'; restoreFiles?: boolean; keepSource?: boolean; message?: string },
): Promise<RewindResult> {
  return apiPost(`/api/sessions/${sessionId}/rewind`, {
    message_uuid: messageUuid,
    ...(opts?.mode ? { mode: opts.mode } : {}),
    ...(opts?.restoreFiles !== undefined ? { restore_files: opts.restoreFiles } : {}),
    ...(opts?.keepSource !== undefined ? { keep_source: opts.keepSource } : {}),
    ...(opts?.message !== undefined ? { message: opts.message } : {}),
  });
}

// ── Forensic Observability ──

/** Minimal incident shape the UI needs back from the Investigate button. */
export interface Incident {
  id: string;
  sessionId: string;
  taskId?: string;
  trigger: 'invariant' | 'manual' | 'canary' | 'client';
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
