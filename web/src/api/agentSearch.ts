/**
 * Client for GET /api/search/agent — the AI task-search lane.
 * Module-level memo (pattern: aiSummaryMemo in SessionDiffView) because every
 * miss costs a full claude -p run server-side.
 */

import { apiGet } from '@/api/client';

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

/** The engine runs up to ~50s server-side; 65s keeps the client from giving
 *  up before the route's own 60s deadline answers. */
const CLIENT_TIMEOUT_MS = 65_000;

export async function fetchAgentSearch(
  q: string,
  opts: { signal?: AbortSignal; sid?: string } = {},
): Promise<AgentSearchPayload> {
  const payload = await apiGet<AgentSearchPayload>(
    '/api/search/agent',
    { q: q.trim(), ...(opts.sid ? { sid: opts.sid } : {}) },
    { signal: opts.signal, timeoutMs: CLIENT_TIMEOUT_MS },
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
