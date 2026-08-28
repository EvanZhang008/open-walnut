/**
 * Micro agent — the LIGHTWEIGHT session primitive.
 *
 * A deliberate contrast with every other way to run a model here:
 *   - claude -p (inline-subagent): full Claude Code — 32k tokens of CLI system
 *     prompt + 24 tool manuals in an EMPTY directory, plus the whole
 *     CLAUDE.md/AGENTS.md chain of whatever cwd it lands in (~56k measured in
 *     this repo). Every model round pays that context in first-token latency.
 *   - SubagentRunner (embedded): session records, JSONL history, skills,
 *     context sources — right for a visible task worker, heavy for a utility.
 *
 * runMicroAgent() is neither: an in-process runAgentLoop turn that inherits
 * NOTHING — no CLAUDE.md, no skills prompt, no memory, no prompt cache — just
 * the caller's small system prompt and native in-process tools. First-round
 * context is whatever the caller writes (task search: ~1.2k tokens vs the
 * CLI child's ~145k cumulative).
 *
 * What it standardizes so callers stop hand-rolling it:
 *   - model tier resolution against the configured provider's catalog
 *   - wall-clock timeout via AbortController (the loop stops after the
 *     current tool; `aborted` is surfaced, never swallowed)
 *   - per-call usage accounting under the caller's UsageSource
 *   - tight defaults: 3 tool rounds, 2000 max output tokens, 30s
 *
 * First consumer: the ✦ AI task-search lane (core/task-search-agent.ts).
 */

import type { AgentCallbacks } from './loop.js';
import type { ToolDefinition } from './tools.js';
import type { UsageSource } from '../core/usage/types.js';

export interface MicroAgentOptions {
  /** Small, caller-owned system prompt. This is ALL the model knows. */
  system: string;
  userMessage: string;
  /** Native in-process tools (plain functions, no process spawns). */
  tools?: ToolDefinition[];
  /** Explicit model id wins; otherwise `tier` picks from the provider catalog. */
  model?: string;
  /** Catalog pick when `model` is absent: first non-1M id containing this. */
  tier?: 'haiku' | 'sonnet' | 'opus';
  maxTokens?: number;
  maxToolRounds?: number;
  timeoutMs?: number;
  /** Every micro agent is accounted — no anonymous background model calls. */
  usageSource: UsageSource;
  /** Streaming/progress callbacks; onUsage composes with the built-in recorder. */
  callbacks?: AgentCallbacks;
}

export interface MicroAgentResult {
  response: string;
  model: string;
  aborted: boolean;
}

const DEFAULT_TIER = 'sonnet';
const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

/** First catalog entry for the configured provider matching the tier,
 *  skipping -1M variants (a micro agent never needs a 1M window). */
export async function resolveTierModel(tier: string): Promise<{ model: string; provider: string }> {
  const { getConfig } = await import('../core/config-manager.js');
  const config = await getConfig();
  const provider = config.agent?.main_provider ?? 'bedrock';
  const { MODEL_CATALOG } = await import('./providers/model-catalog.js');
  const entry = MODEL_CATALOG[provider]?.find((m) => {
    const id = m.id.toLowerCase();
    return id.includes(tier) && !id.includes('1m');
  });
  return { model: entry?.id ?? config.agent?.model ?? tier, provider };
}

export async function runMicroAgent(opts: MicroAgentOptions): Promise<MicroAgentResult> {
  const { runAgentLoop } = await import('./loop.js');
  const { usageTracker } = await import('../core/usage/index.js');

  const { model, provider } = opts.model
    ? { model: opts.model, provider: (await resolveTierModel(opts.tier ?? DEFAULT_TIER)).provider }
    : await resolveTierModel(opts.tier ?? DEFAULT_TIER);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const result = await runAgentLoop(opts.userMessage, [], {
      ...opts.callbacks,
      onUsage: (usage) => {
        try {
          usageTracker.record({
            source: opts.usageSource,
            model: usage.model ?? model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
          });
        } catch { /* accounting must never fail the run */ }
        opts.callbacks?.onUsage?.(usage);
      },
    }, {
      system: opts.system,
      tools: opts.tools ?? [],
      modelConfig: { model, provider, maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS },
      maxToolRounds: opts.maxToolRounds ?? DEFAULT_MAX_ROUNDS,
      // No prompt cache: micro prompts are tiny and one-shot; cache markers
      // would only churn the shared cache-TTL tracker.
      cacheConfig: false,
      signal: controller.signal,
      source: opts.usageSource,
    });
    return { response: result.response, model, aborted: result.aborted === true };
  } finally {
    clearTimeout(timer);
  }
}
