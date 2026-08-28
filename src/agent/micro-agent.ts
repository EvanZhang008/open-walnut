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
 *     (overridable: explicit `model` + `provider` win)
 *   - wall-clock timeout via AbortController (the loop stops after the
 *     current tool; `aborted` is surfaced, never swallowed), composed with an
 *     optional caller `signal`
 *   - per-call usage accounting under the caller's UsageSource
 *   - tight defaults: 3 tool rounds, 2000 max output tokens, 30s
 *   - multi-turn reuse: pass a prior run's `messages` back as `history`, or
 *     use createMicroSession() which threads it for you
 *
 * These runs are in-process API turns — they create NO session record, no
 * transcript on disk, nothing the session import scan could ever pick up.
 * (The claude -p escape hatches DO write CLI transcripts; see
 * inline-subagent.ts `slim` for how those stay out of the repo's project dir.)
 *
 * First consumer: the ✦ AI task-search lane (core/task-search-agent.ts).
 */

import type { AgentCallbacks } from './loop.js';
import type { MessageParam } from './model.js';
import type { ToolDefinition } from './tools.js';
import type { UsageSource } from '../core/usage/types.js';

export interface MicroAgentOptions {
  /** Small, caller-owned system prompt. This is ALL the model knows. */
  system: string;
  userMessage: string;
  /** Prior turns to continue from (e.g. a previous run's `messages`).
   *  Default: fresh conversation. */
  history?: MessageParam[];
  /** Native in-process tools (plain functions, no process spawns). */
  tools?: ToolDefinition[];
  /** Explicit model id wins; otherwise `tier` picks from the provider catalog. */
  model?: string;
  /** Explicit provider for `model`; otherwise the configured main provider. */
  provider?: string;
  /** Catalog pick when `model` is absent: first non-1M id containing this. */
  tier?: 'haiku' | 'sonnet' | 'opus';
  maxTokens?: number;
  maxToolRounds?: number;
  timeoutMs?: number;
  /** External cancellation (composes with the timeout — whichever fires first). */
  signal?: AbortSignal;
  /** Every micro agent is accounted — no anonymous background model calls. */
  usageSource: UsageSource;
  /** Streaming/progress callbacks; onUsage composes with the built-in recorder. */
  callbacks?: AgentCallbacks;
}

export interface MicroAgentResult {
  response: string;
  model: string;
  aborted: boolean;
  /** Full updated history (input history + this turn) — feed it back as
   *  `history` to continue the conversation. */
  messages: MessageParam[];
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
    ? {
        model: opts.model,
        provider: opts.provider ?? (await resolveTierModel(opts.tier ?? DEFAULT_TIER)).provider,
      }
    : await resolveTierModel(opts.tier ?? DEFAULT_TIER);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Compose the caller's signal with the timeout: either aborts the loop.
  const onExternalAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    const result = await runAgentLoop(opts.userMessage, opts.history ?? [], {
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
    return { response: result.response, model, aborted: result.aborted === true, messages: result.messages };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Stateful wrapper for multi-turn reuse: one micro session, N sends, history
 * threaded automatically. Each send accepts per-call overrides (model, tools,
 * timeout, …) on top of the base options.
 *
 *   const session = createMicroSession({ system, usageSource: 'x' });
 *   const a = await session.send('first question');
 *   const b = await session.send('follow-up');   // sees turn 1
 */
export function createMicroSession(base: Omit<MicroAgentOptions, 'userMessage' | 'history'>): {
  send: (userMessage: string, overrides?: Partial<Omit<MicroAgentOptions, 'userMessage' | 'history'>>) => Promise<MicroAgentResult>;
  history: () => MessageParam[];
} {
  let history: MessageParam[] = [];
  return {
    send: async (userMessage, overrides) => {
      const result = await runMicroAgent({ ...base, ...overrides, userMessage, history });
      // A timed-out turn keeps history at the last COMPLETE turn — a partial
      // exchange would poison every later send.
      if (!result.aborted) history = result.messages;
      return result;
    },
    history: () => history,
  };
}
