/**
 * Agent task search — orchestration: gates, cache, in-flight dedup, the
 * concurrency slot gate, and the engine seam.
 *
 * Default engine spawns a one-shot `claude -p` (haiku) whose child searches
 * through the walnut CLI (`walnut tools call search`) — the user's explicit
 * choice: a real claude-code agent, accepted as heavy (10-30s). The engine is
 * a function seam (pattern: ReviewRunner in agent/background-review.ts) so an
 * in-process runAgentLoop fast path can replace it without touching callers.
 *
 * NOTE: backgroundAiDisabled() gates this feature, so it is OFF on every test
 * server (vitest/Playwright fixtures) and under WALNUT_DISABLE_BACKGROUND_AI=1
 * — a hidden AI panel there is correct behavior, not a bug.
 */

import { randomUUID } from 'node:crypto';
import { backgroundAiDisabled } from './cheap-model.js';
import { resolveClaudeCliExecutable } from './claude-cli-detect.js';
import { listTasks } from './task-manager.js';
import { usageTracker } from './usage/index.js';
import { count, observe } from './observability/metrics.js';
import { log } from '../logging/index.js';
import {
  AGENT_SEARCH_PROMPT_V,
  SYSTEM_PROMPT,
  buildUserPrompt,
  normalizeQueryKey,
  parseAgentAnswer,
  rankAgentResults,
  validateAndEnrich,
  type AgentSearchResult,
} from './task-search-agent-contract.js';

export type { AgentSearchResult } from './task-search-agent-contract.js';

export class AgentSearchError extends Error {
  statusCode: number;
  extra?: Record<string, unknown>;
  constructor(message: string, statusCode: number, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'AgentSearchError';
    this.statusCode = statusCode;
    this.extra = extra;
  }
}

export interface AgentSearchResponse {
  summary?: string;
  results: AgentSearchResult[];
  model: string;
  tookMs: number;
  cached: boolean;
}

export interface AgentSearchEngineOptions {
  system: string;
  model: string;
  timeoutMs: number;
}

/** The seam: returns the child's final answer text. */
export type AgentSearchEngine = (
  userPrompt: string,
  options: AgentSearchEngineOptions,
) => Promise<{ response: string; model?: string; costUsd?: number }>;

const ENGINE_MODEL = 'haiku';
const ENGINE_TIMEOUT_MS = 50_000;

async function claudeCliEngine(
  userPrompt: string,
  options: AgentSearchEngineOptions,
): Promise<{ response: string; model?: string; costUsd?: number }> {
  const { runInlineSubagent } = await import('../providers/inline-subagent.js');
  const run = await runInlineSubagent({
    prompt: userPrompt,
    model: options.model,
    timeoutMs: options.timeoutMs,
    systemPrompt: options.system,
    toolUseId: `task-search-${randomUUID()}`,
  });
  if (!run.success) throw new Error(run.error ?? 'claude -p exited with an error');
  return { response: run.result, model: options.model, costUsd: run.costUsd };
}

const MAX_CONCURRENT_CALLS = 2;
const MAX_QUEUED_CALLS = 4;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_CAP = 50;
const MIN_QUERY_CHARS = 4;
const MAX_QUERY_CHARS = 400;

// Tiny semaphore. Shape note (copied from diff-summary.ts): the increment
// happens in the WAITER after its resolve fires, not in releaseCallSlot —
// moving it into release double-counts.
let activeCalls = 0;
const waiters: Array<() => void> = [];
async function acquireCallSlot(): Promise<void> {
  if (activeCalls < MAX_CONCURRENT_CALLS) { activeCalls += 1; return; }
  if (waiters.length >= MAX_QUEUED_CALLS) {
    throw new AgentSearchError('Too many AI searches pending — try again shortly', 429, { code: 'busy' });
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  activeCalls += 1;
}
function releaseCallSlot(): void {
  activeCalls -= 1;
  waiters.shift()?.();
}

const inflight = new Map<string, Promise<AgentSearchResponse>>();
const cache = new Map<string, { at: number; value: AgentSearchResponse }>();

/** `which claude` equivalent, resolved once — a missing CLI is permanent for
 *  the process lifetime, and the client latches 503 ai_disabled the same way. */
let cliAvailable: boolean | null = null;

export interface RunTaskSearchAgentOptions {
  engine?: AgentSearchEngine;
  timeoutMs?: number;
}

/**
 * ⚠️ Non-async wrapper; the inflight get/set happens BEFORE any await so two
 * concurrent identical queries share one run (diff-summary.ts lesson).
 */
export function runTaskSearchAgent(
  query: string,
  opts: RunTaskSearchAgentOptions = {},
): Promise<AgentSearchResponse> {
  const key = `${AGENT_SEARCH_PROMPT_V}:${normalizeQueryKey(query)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Promise.resolve({ ...hit.value, cached: true, tookMs: 0 });
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = inner(query, key, opts).finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}

async function inner(
  query: string,
  cacheKey: string,
  opts: RunTaskSearchAgentOptions,
): Promise<AgentSearchResponse> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_CHARS) {
    throw new AgentSearchError(`query must be at least ${MIN_QUERY_CHARS} characters`, 400);
  }
  if (trimmed.length > MAX_QUERY_CHARS) {
    throw new AgentSearchError(`query must be at most ${MAX_QUERY_CHARS} characters`, 400);
  }
  if (backgroundAiDisabled()) {
    throw new AgentSearchError('AI search is disabled in this environment', 503, { code: 'ai_disabled' });
  }
  // Only the default engine needs the claude binary; injected engines (tests,
  // future in-process loop) must not be blocked by a CLI-less machine.
  if (!opts.engine) {
    cliAvailable ??= resolveClaudeCliExecutable() !== null;
    if (!cliAvailable) {
      throw new AgentSearchError('claude CLI not available on this host', 503, { code: 'ai_disabled' });
    }
  }

  await acquireCallSlot();
  const t0 = Date.now();
  let answer: { response: string; model?: string; costUsd?: number };
  try {
    const engine = opts.engine ?? claudeCliEngine;
    answer = await engine(buildUserPrompt(trimmed), {
      system: SYSTEM_PROMPT,
      model: ENGINE_MODEL,
      timeoutMs: opts.timeoutMs ?? ENGINE_TIMEOUT_MS,
    });
  } catch (err) {
    count('search.agent.result', 1, { outcome: 'engine_error' });
    throw new AgentSearchError(
      `AI search failed: ${err instanceof Error ? err.message : String(err)}`, 502, { code: 'agent_failed' },
    );
  } finally {
    releaseCallSlot();
  }

  const model = answer.model ?? ENGINE_MODEL;
  if (answer.costUsd !== undefined) {
    try {
      usageTracker.record({
        source: 'task-search-agent',
        model,
        external_cost_usd: answer.costUsd,
        duration_ms: Date.now() - t0,
      });
    } catch { /* accounting must never fail the search */ }
  }

  let raw;
  try {
    raw = parseAgentAnswer(answer.response);
  } catch (err) {
    log.web.warn('task-search-agent: unparseable answer', {
      error: err instanceof Error ? err.message : String(err),
      head: answer.response.slice(0, 200),
    });
    count('search.agent.result', 1, { outcome: 'unparseable' });
    throw new AgentSearchError('AI search returned an unreadable answer', 502, { code: 'unparseable' });
  }

  const { summary, results, droppedIds } = validateAndEnrich(raw, await listTasks());
  const tookMs = Date.now() - t0;
  const out: AgentSearchResponse = {
    ...(summary ? { summary } : {}),
    results: rankAgentResults(results),
    model,
    tookMs,
    cached: false,
  };
  cache.set(cacheKey, { at: Date.now(), value: out });
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  observe('search.agent.ms', tookMs);
  count('search.agent.result', 1, { outcome: results.length > 0 ? 'hit' : 'empty' });
  if (droppedIds > 0) count('search.agent.invented_ids', droppedIds);
  return out;
}

/** Test hook: clears cache, in-flight map, and the CLI-availability latch. */
export function _resetAgentSearchStateForTesting(): void {
  cache.clear();
  inflight.clear();
  cliAvailable = null;
  activeCalls = 0;
  waiters.length = 0;
}
