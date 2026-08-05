import { apiGet, apiPatch, apiPost, ApiError } from './client';
import type { SessionSummary, SessionRecord, SessionEffort, SessionModelCatalogEntry } from '@open-walnut/core';
import type { ImageAttachment } from './chat';
import type { SessionHistoryMessage } from '@/types/session';
import { log } from '@/utils/log';
import {
  seedSessionStatus,
  seedTaskSessionStatuses,
  sessionStatusStore,
} from '@/stores/session-status-store';

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

export async function fetchSessionSummaries(limit?: number): Promise<SessionSummary[]> {
  const params = limit ? { limit: String(limit) } : undefined;
  const res = await apiGet<{ summaries: SessionSummary[] }>('/api/sessions/summaries', params);
  return res.summaries;
}

const STATUS_HYDRATION_BATCH_SIZE = 100;

export async function hydrateSessionStatuses(sessionIds: Iterable<string>): Promise<void> {
  const uniqueIds = [...new Set(sessionIds)]
    .filter((sessionId) => sessionId && !sessionId.startsWith('pending:'));
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
  forkBoundaryIndex?: number;
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
}

export async function fetchSessionHistory(
  sessionId: string,
  opts?: { source?: 'streams'; signal?: AbortSignal; since?: number },
): Promise<SessionHistoryResult> {
  const params: Record<string, string> = {};
  if (opts?.source) params.source = opts.source;
  // Delta mode: ask only for messages after the client's cursor. Server returns a
  // small slice (usually 1-5 messages) + the new cursor. Empty slice = archive
  // hasn't caught up yet (turn not flushed); caller keeps streaming blocks & retries.
  if (opts?.since !== undefined) params.since = String(opts.since);
  // Remote sessions + fork chains can take 20-30s on first load (SSH pulls 3+ MB JSONL
  // serially through a corporate proxy). Streams path is local-only and fast; full path may be
  // slow — and a WHALE session (>10MB JSONL, chunked fs.readRange server-side, 120s
  // server ceiling) legitimately exceeds the old 60s; aborting client-side just wasted
  // the transfer and re-requested from zero (inc-1783532915925).
  const timeoutMs = opts?.source === 'streams' ? 15_000 : 150_000;
  const res = await apiGet<{
    messages: SessionHistoryMessage[];
    forkBoundaryIndex?: number;
    cursor?: number;
    delta?: boolean;
    stale?: boolean;
    staleReason?: string;
    historyUnavailable?: string;
  }>(
    `/api/sessions/${sessionId}/history`, params, { signal: opts?.signal, timeoutMs },
  );
  if (res.historyUnavailable) {
    throw new Error(`HISTORY_UNAVAILABLE:${res.historyUnavailable}`);
  }
  return {
    messages: res.messages,
    forkBoundaryIndex: res.forkBoundaryIndex,
    cursor: res.cursor,
    delta: res.delta,
    stale: res.stale,
    staleReason: res.staleReason,
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

export async function updateSession(sessionId: string, updates: { title?: string; human_note?: string; archived?: boolean; archive_reason?: string; mode?: string }): Promise<SessionRecord> {
  const res = await apiPatch<{ session: SessionRecord }>(`/api/sessions/${sessionId}`, updates);
  seedSessionStatus(res.session, 'rest:session');
  return res.session;
}

export async function fetchSessionsForTask(taskId: string): Promise<SessionRecord[]> {
  const res = await apiGet<{ sessions: SessionRecord[] }>(`/api/sessions/task/${taskId}`);
  for (const session of res.sessions) seedSessionStatus(session, 'rest:session-list');
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

export interface CodexModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

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
  engine: 'claude' | 'codex';
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
  category: string;
  count: number;
  lastUsed: string;
  /** Launch config remembered from the last Quick Start on this dir. `model`
   *  is the raw picker value (catalog ID or legacy alias). Absent = Auto/Claude. */
  lastLaunch?: { model?: string; engine?: 'codex' };
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
  starred?: boolean;
  needs_attention?: boolean;
  priority?: 'immediate' | 'important' | 'backlog' | 'none';
  /** Tier to pin the new task to — a built-in name or a custom tier id (`ct_*`).
   *  `null` = explicitly DON'T pin — distinct from omitted, which lets the server
   *  apply its own default (fix-walnut → Satellite, the same launcher baseline as
   *  a regular quick session). */
  pinTier?: string | null;
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
  /** Launch intent — 'fix-walnut' makes the server wrap the message in a repair briefing. */
  intent?: 'fix-walnut';
  /** User opted into "create & start": server mkdirs the cwd before starting. */
  createCwd?: boolean;
  /** Coding-agent engine. undefined = 'claude'; 'codex' → ACP-backed session (local-only). */
  engine?: 'codex';
  /** `sessionId` is present for native (claude) starts; a Codex start omits it. */
}): Promise<{ taskId: string; task: unknown; sessionId?: string }> {
  // Convert ImageAttachment[] to the backend ImagePayload format (data + mediaType only)
  const payload: Record<string, unknown> = { ...opts };
  if (opts.images?.length) {
    payload.images = opts.images.map(img => ({ data: img.data, mediaType: img.mediaType }));
  } else {
    delete payload.images;
  }
  // CLIENT-OWNED session id (native engine only — Codex's ACP adapter assigns its
  // own). The server honors it as the preassigned id, which makes the launch
  // reconcilable even if this HTTP response never arrives: the caller can poll
  // GET /api/sessions/<id> instead of being stuck on a placeholder. This is the
  // root fix for the false-"Failed"-then-duplicate-on-Retry incident (2026-08-03:
  // server 200 in 2.7s, browser AbortSignal fired at 15s under main-thread jam).
  const clientSessionId = opts.engine !== 'codex' && typeof crypto?.randomUUID === 'function'
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

export async function retrySession(sessionId: string): Promise<
  { status: 'reconnected'; sessionId: string } |
  { status: 'resuming'; sessionId: string } |
  { status: 'pending'; taskId: string; oldSessionId: string }
> {
  return apiPost(`/api/sessions/${sessionId}/retry`, {});
}

export async function restartSession(sessionId: string): Promise<
  { status: 'restarted'; sessionId: string; pendingMessages?: number }
> {
  return apiPost(`/api/sessions/${sessionId}/restart`, {});
}

/** Terminate a session — closes the CLI process (no respawn) and marks it stopped. */
export async function terminateSession(sessionId: string): Promise<
  { status: 'terminated'; sessionId: string }
> {
  return apiPost(`/api/sessions/${sessionId}/terminate`, {});
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
): Promise<{ status: string; sourceSessionId: string; sessionId: string; taskId: string; childTaskCreated?: boolean }> {
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
