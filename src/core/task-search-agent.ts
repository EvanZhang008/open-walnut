/**
 * Agent task search — orchestration: gates, cache, in-flight dedup, the
 * concurrency slot gate, and the engine seam.
 *
 * Default engine is an IN-PROCESS runAgentLoop (sonnet) with one native
 * `search` tool. The original claude -p child (haiku + `walnut tools call`)
 * remains behind WALNUT_AGENT_SEARCH_ENGINE=cli. Profiled 2026-08-27: the CLI
 * harness taxes every round (huge CLI system prompt -> slow first token,
 * thinking warm-up, ~1s Bash+walnut spawn per search), 13-20s/query at
 * $0.06-0.13 on haiku and 27s at $0.68 on sonnet; in-process cuts both the
 * per-round tax and the tool spawn to ~zero, so sonnet quality fits the
 * latency budget. The seam (pattern: ReviewRunner in background-review.ts)
 * is what made this swap caller-invisible.
 *
 * NOTE: backgroundAiDisabled() gates this feature, so it is OFF on every test
 * server (vitest/Playwright fixtures) and under WALNUT_DISABLE_BACKGROUND_AI=1
 * — a hidden AI panel there is correct behavior, not a bug.
 */

import { randomUUID } from 'node:crypto';
import { bus, EventNames } from './event-bus.js';
import { backgroundAiDisabled } from './cheap-model.js';
import { resolveClaudeCliExecutable } from './claude-cli-detect.js';
import { listTasks } from './task-manager.js';
import { usageTracker } from './usage/index.js';
import { count, observe } from './observability/metrics.js';
import { log } from '../logging/index.js';
import {
  AGENT_SEARCH_PROMPT_V,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_TOOL_LOOP,
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
  /** Raw (trimmed) query — the in-process engine pre-runs it as seed results. */
  query?: string;
  /** Client-chosen id: when set, the in-process engine emits live
   *  'search-agent:progress' events (mini-session lines in the panel). */
  progressId?: string;
}

/** The seam: returns the child's final answer text. */
export type AgentSearchEngine = (
  userPrompt: string,
  options: AgentSearchEngineOptions,
) => Promise<{ response: string; model?: string; costUsd?: number }>;

const CLI_ENGINE_MODEL = 'haiku';
const CLI_ENGINE_TIMEOUT_MS = 50_000;
// 45s, not 30: a hard query legitimately runs seed + 2 variant rounds + the
// answer turn (~35s of sonnet round-trips; a live 3-round run hit 30.8s and
// 502'd). The route's 60s deadline and the client's 65s stay the outer walls.
const IN_PROCESS_TIMEOUT_MS = 45_000;
// 2 tool rounds max — exactly the contract in SYSTEM_PROMPT_TOOL_LOOP (seed is
// pre-run; at most two batched variant rounds). More is the model wandering,
// and at slow-Bedrock hours (~10s/round measured) a third round races the 45s
// timeout. Exhaustion falls into the loop's final no-tools call, which the
// prompt requires to be the JSON answer.
const IN_PROCESS_MAX_ROUNDS = 2;

/** Escape hatch back to the original claude -p child. */
function useCliEngine(): boolean {
  return process.env.WALNUT_AGENT_SEARCH_ENGINE === 'cli';
}

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
    // Slim preset: replace the CLI system prompt, no settings/CLAUDE.md,
    // --bare, neutral tmpdir cwd (32.5k → 3.6k tokens measured; see
    // inline-subagent.ts). Bash stays on — the child searches via the
    // walnut CLI.
    slim: true,
    tools: ['Bash'],
  });
  if (!run.success) throw new Error(run.error ?? 'claude -p exited with an error');
  return { response: run.result, model: options.model, costUsd: run.costUsd };
}

// Every input token is round-trip latency in the answer turn (profiled: a
// 7.4k-token round 2 took 10.4s), so both the per-search row count and the
// snippet length are capped tighter than the UI's instant lane.
const SEARCH_ROW_LIMIT = 8;
const SNIPPET_CAP = 240;
const ANSWER_MAX_TOKENS = 2000;

type SearchRows = Awaited<ReturnType<typeof import('./search.js')['search']>>;

function serializeRows(rows: SearchRows): string {
  return JSON.stringify(rows.map((r) => ({
    type: r.type,
    title: r.title,
    snippet: [...(r.snippet ?? '')].slice(0, SNIPPET_CAP).join(''),
    ...(r.taskId ? { taskId: r.taskId } : {}),
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    score: r.score,
  })));
}

async function inProcessEngine(
  userPrompt: string,
  options: AgentSearchEngineOptions,
): Promise<{ response: string; model?: string; costUsd?: number }> {
  const { runMicroAgent } = await import('../agent/micro-agent.js');
  const { search } = await import('./search.js');
  const { buildSeedResultsBlock } = await import('./task-search-agent-contract.js');

  // Live progress → browser panel (mini-session lines). Best-effort: never
  // let a broken emit fail the search.
  const pid = options.progressId;
  const progress = (data: { kind: 'seed' | 'search' | 'search_done' | 'answering'; q?: string; count?: number }) => {
    if (!pid) return;
    try {
      bus.emit(EventNames.SEARCH_AGENT_PROGRESS, { id: pid, ...data }, ['web-ui'], { source: 'task-search-agent' });
    } catch { /* progress is decoration */ }
  };

  const searchTool = {
    name: 'search',
    description: 'Search the user\'s Walnut tasks and session transcripts. Returns JSON rows; a row with type "session" carries taskId = the task that OWNS that transcript. Batch query variants as parallel calls in one reply.',
    input_schema: {
      type: 'object' as const,
      properties: {
        q: { type: 'string', description: 'Search terms — one query per call' },
      },
      required: ['q'],
    },
    execute: async (params: Record<string, unknown>) => {
      const q = String(params.q ?? '').trim();
      if (!q) return 'Error: empty query';
      const rows = await search(q, { types: ['task', 'session'], limit: SEARCH_ROW_LIMIT });
      return serializeRows(rows);
    },
  };

  // Pre-run the raw query so the common case is ONE model round (answer
  // directly from the seed) instead of two (search round + answer round).
  let prompt = userPrompt;
  if (options.query) {
    try {
      const seed = await search(options.query, { types: ['task', 'session'], limit: SEARCH_ROW_LIMIT });
      prompt += buildSeedResultsBlock(serializeRows(seed));
      progress({ kind: 'seed', q: options.query, count: seed.length });
    } catch { /* seeding is an optimization — the loop can still search */ }
  }

  const qByToolUse = new Map<string, string>();
  let answering = false;
  const result = await runMicroAgent({
    system: options.system,
    userMessage: prompt,
    tools: [searchTool],
    tier: 'sonnet',
    // Quality floor per user decision is sonnet; env overrides for experiments.
    model: process.env.WALNUT_AGENT_SEARCH_MODEL?.trim() || undefined,
    maxTokens: ANSWER_MAX_TOKENS,
    maxToolRounds: IN_PROCESS_MAX_ROUNDS,
    timeoutMs: options.timeoutMs,
    usageSource: 'task-search-agent',
    callbacks: {
      onToolCall: (toolName, input, toolUseId) => {
        if (toolName !== 'search') return;
        const q = String((input as { q?: unknown }).q ?? '');
        qByToolUse.set(toolUseId, q);
        progress({ kind: 'search', q });
      },
      onToolResult: (toolName, result, toolUseId) => {
        if (toolName !== 'search') return;
        let count: number | undefined;
        try { count = (JSON.parse(result) as unknown[]).length; } catch { /* row count is decoration */ }
        progress({ kind: 'search_done', q: qByToolUse.get(toolUseId), count });
      },
      onTextDelta: () => {
        if (answering) return;
        answering = true;
        progress({ kind: 'answering' });
      },
    },
  });
  if (result.aborted) throw new Error(`AI search timed out after ${options.timeoutMs}ms`);
  return { response: result.response, model: result.model };
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
  /** Forwarded to the engine for live progress events (best-effort). */
  progressId?: string;
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
  // Only the CLI engine needs the claude binary; the in-process default and
  // injected engines (tests) must not be blocked by a CLI-less machine.
  const cliEngine = !opts.engine && useCliEngine();
  if (cliEngine) {
    cliAvailable ??= resolveClaudeCliExecutable() !== null;
    if (!cliAvailable) {
      throw new AgentSearchError('claude CLI not available on this host', 503, { code: 'ai_disabled' });
    }
  }

  await acquireCallSlot();
  const t0 = Date.now();
  let answer: { response: string; model?: string; costUsd?: number };
  try {
    const engine = opts.engine ?? (cliEngine ? claudeCliEngine : inProcessEngine);
    answer = await engine(buildUserPrompt(trimmed), {
      system: cliEngine ? SYSTEM_PROMPT : SYSTEM_PROMPT_TOOL_LOOP,
      model: CLI_ENGINE_MODEL,
      timeoutMs: opts.timeoutMs ?? (cliEngine ? CLI_ENGINE_TIMEOUT_MS : IN_PROCESS_TIMEOUT_MS),
      query: trimmed,
      ...(opts.progressId ? { progressId: opts.progressId } : {}),
    });
  } catch (err) {
    count('search.agent.result', 1, { outcome: 'engine_error' });
    throw new AgentSearchError(
      `AI search failed: ${err instanceof Error ? err.message : String(err)}`, 502, { code: 'agent_failed' },
    );
  } finally {
    releaseCallSlot();
  }

  const model = answer.model ?? CLI_ENGINE_MODEL;
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
