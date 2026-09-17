/**
 * Client for GET /api/search/agent — the AI task-search lane.
 * Module-level memo (pattern: aiSummaryMemo in SessionDiffView) because every
 * miss costs a full claude -p run server-side.
 */

import { apiGet, apiPost } from '@/api/client';

export interface AgentSearchRow {
  taskId: string;
  title: string;
  phase?: string;
  project?: string;
  evidence: string;
  confidence?: 'high' | 'medium' | 'low';
  updatedAt?: string;
}

export interface AgentSearchPayload {
  summary?: string;
  results: AgentSearchRow[];
  model: string;
  tookMs: number;
  cached?: boolean;
}

const memo = new Map<string, AgentSearchPayload>();
const MEMO_CAP = 30;

function memoKey(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function peekAgentSearch(q: string): AgentSearchPayload | undefined {
  return memo.get(memoKey(q));
}

/** The engine runs up to ~80s server-side; 95s keeps the client from giving
 *  up before the route's own 90s deadline answers. */
const CLIENT_TIMEOUT_MS = 95_000;

export async function fetchAgentSearch(
  q: string,
  opts: { signal?: AbortSignal; sid?: string } = {},
): Promise<AgentSearchPayload> {
  const payload = await apiGet<AgentSearchPayload>(
    '/api/search/agent',
    { q: q.trim(), ...(opts.sid ? { sid: opts.sid } : {}) },
    // 503 = ai_disabled: expected degrade where AI search is off (test
    // fixtures, replicas without credentials) — warn, not an audited error.
    { signal: opts.signal, timeoutMs: CLIENT_TIMEOUT_MS, quietStatuses: [503] },
  );
  // Memoize BEFORE any abort bail upstream — a late landing still warms the
  // cache for when the user retypes the same query.
  memo.set(memoKey(q), payload);
  if (memo.size > MEMO_CAP) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return payload;
}

export function _clearAgentSearchMemoForTesting(): void {
  memo.clear();
}

export interface AdoptedSearchSession {
  sessionId: string;
  taskId: string;
  /** The search's session was already adopted earlier — this is that same
   *  conversation, not a second copy of it. */
  reused: boolean;
}

/**
 * Reopen the session the AI lane ran this search in.
 *
 * The lane is a real claude session, so its conversation (question, searches,
 * answer) already exists; adopting it hands the user that transcript instead of
 * a fresh agent that would redo the work. `null` = there is nothing to reopen
 * (lane off/failed/disabled, or the run has aged out of the server's map) and
 * the caller should start a session the normal way.
 *
 * Keyed by QUERY, never by session id: the browser must not be able to name an
 * arbitrary claude session on the host and have Walnut adopt it.
 *
 * The request may WAIT on a search that is still running (the point of the
 * button is that you can press it during those 14 seconds), so it carries the
 * lane's own client timeout rather than the default.
 */
export interface AdoptSearchSessionOptions {
  /**
   * May the server RUN the search when none has yet? True while the ✦ lane is
   * on and healthy (the lane debounces ~1s, so a fast click arrives before any
   * search exists). FALSE when the human switched the lane off or it just
   * failed: a search they turned off must not be run behind their back.
   */
  search: boolean;
  /** The card's progress id, so a search started by this press still streams its
   *  live lines into the panel being watched. */
  progressId?: string;
}

export async function adoptAgentSearchSession(
  q: string,
  opts: AdoptSearchSessionOptions,
): Promise<AdoptedSearchSession | null> {
  try {
    const adopted = await apiPost<AdoptedSearchSession>(
      '/api/search/agent/session',
      { q: q.trim(), search: opts.search, ...(opts.progressId ? { progressId: opts.progressId } : {}) },
      // 404 = "no session for this query", a designed answer that routes the
      // caller to its fallback; auditing it as an error would be noise.
      { timeoutMs: CLIENT_TIMEOUT_MS, quietStatuses: [404] },
    );
    // A 200 that is not an adopt answer counts as "nothing to reopen", never as
    // success: this path sits one segment below the lane's own GET, so anything
    // matching by prefix (a test stub, a proxy, a stale service worker) can hand
    // back the wrong shape — and a truthy object with no session id would open
    // NOTHING while the caller believed it had (found exactly that way).
    return typeof adopted?.sessionId === 'string' && adopted.sessionId ? adopted : null;
  } catch {
    return null;
  }
}
