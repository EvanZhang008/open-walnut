/**
 * Micro agent — the LIGHTWEIGHT model turn with tools.
 *
 * A deliberate contrast with a `claude -p` child: full Claude Code is ~32k
 * tokens of CLI system prompt plus 24 tool manuals plus the whole
 * CLAUDE.md/AGENTS.md chain of whatever cwd it lands in (~56k measured in this
 * repo), and every round pays that in first-token latency. A caller that fires
 * hundreds of times a day and usually finds nothing (a routine watcher polling
 * a mailbox) cannot afford that per tick.
 *
 * runMicroAgent() inherits NOTHING: no CLAUDE.md, no skills index, no memory, no
 * prompt cache, no history on disk. First-round context is whatever the caller
 * writes (a watcher's prompt: ~1.2k tokens).
 *
 * What it standardizes so callers stop hand-rolling it:
 *   - model tier resolution against the configured provider's catalog
 *     (overridable: explicit `model` + `provider` win)
 *   - wall-clock timeout via AbortController (the loop stops after the current
 *     tool; `aborted` is surfaced, never swallowed), composed with an optional
 *     caller `signal`
 *   - per-call usage accounting under the caller's UsageSource
 *   - tight defaults: 3 tool rounds, 2000 max output tokens, 30s
 *   - multi-turn reuse: pass a prior run's `messages` back as `history`, or use
 *     createMicroSession() which threads it for you
 *
 * These runs are in-process API turns — they create NO session record, no
 * transcript on disk, nothing the session import scan could ever pick up.
 *
 * Non-streaming on purpose: one `sendMessage` per round. There is no partial
 * text to show anywhere (no chat surface renders a micro run), and a streamed
 * round would only add a second code path to keep correct.
 */

import { sendMessage, type MessageParam, type Tool, type UsageStats } from './model.js';
import type { ToolDefinition, ToolExecuteMeta, ToolResultContent } from './tools.js';
import { resolveMainProviderName } from './providers/default-provider.js';
import type { UsageSource } from '../core/usage/types.js';
import { log } from '../logging/index.js';

/** Progress hooks. Every one is optional and every one is best-effort. */
export interface MicroAgentCallbacks {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolCall?: (toolName: string, input: Record<string, unknown>, toolUseId: string) => void;
  onToolResult?: (toolName: string, result: string, toolUseId: string) => void;
  onUsage?: (usage: UsageStats) => void;
}

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
  /** Progress callbacks; onUsage composes with the built-in recorder. */
  callbacks?: MicroAgentCallbacks;
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

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: ToolResultContent; is_error?: boolean };

/**
 * Detect whether a tool result represents an error. Every tool error path
 * produces a string starting with "Error:" or "Error executing"; `is_error`
 * tells the model to retry or report instead of trusting the text as output.
 */
export function isToolResultError(result: ToolResultContent): boolean {
  const text = typeof result === 'string'
    ? result
    : (result.find((b) => b.type === 'text') as { text: string } | undefined)?.text ?? '';
  return /^Error[:\s]/i.test(text);
}

/** First catalog entry for the configured provider matching the tier,
 *  skipping -1M variants (a micro agent never needs a 1M window). */
export async function resolveTierModel(tier: string): Promise<{ model: string; provider: string }> {
  const { getConfig } = await import('../core/config-manager.js');
  const config = await getConfig();
  const provider = resolveMainProviderName(config);
  const { MODEL_CATALOG } = await import('./providers/model-catalog.js');
  const entry = MODEL_CATALOG[provider]?.find((m) => {
    const id = m.id.toLowerCase();
    return id.includes(tier) && !id.includes('1m');
  });
  return { model: entry?.id ?? tier, provider };
}

export async function runMicroAgent(opts: MicroAgentOptions): Promise<MicroAgentResult> {
  const { usageTracker } = await import('../core/usage/index.js');

  const { model, provider } = opts.model
    ? {
        model: opts.model,
        provider: opts.provider ?? (await resolveTierModel(opts.tier ?? DEFAULT_TIER)).provider,
      }
    : await resolveTierModel(opts.tier ?? DEFAULT_TIER);

  const tools = opts.tools ?? [];
  const toolSchemas = tools.map((t) => ({
    name: t.name, description: t.description, input_schema: t.input_schema,
  })) as Tool[];
  const maxToolRounds = opts.maxToolRounds ?? DEFAULT_MAX_ROUNDS;
  const meta: ToolExecuteMeta = { source: opts.usageSource };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Compose the caller's signal with the timeout: either aborts the run.
  const onExternalAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const signal = controller.signal;

  const messages: MessageParam[] = [
    ...(opts.history ?? []),
    { role: 'user', content: opts.userMessage } as MessageParam,
  ];
  let response = '';

  const runOneToolUse = async (block: ToolUseBlock): Promise<ToolResultBlock> => {
    if (signal.aborted) {
      return { type: 'tool_result', tool_use_id: block.id, content: '[Aborted]' };
    }
    opts.callbacks?.onToolCall?.(block.name, block.input, block.id);
    const tool = tools.find((t) => t.name === block.name);
    let content: ToolResultContent;
    if (!tool) content = `Error: Unknown tool "${block.name}"`;
    else {
      try {
        content = await tool.execute(block.input, meta);
      } catch (err) {
        content = `Error executing ${block.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // The callback gets a display-safe string; the model gets the full blocks.
    const display = typeof content === 'string'
      ? content
      : content.map((b) => (b.type === 'text' ? b.text : '[image]')).join('\n');
    opts.callbacks?.onToolResult?.(block.name, display, block.id);
    const isError = isToolResultError(content);
    if (isError) log.agent.warn('micro agent tool returned error', { tool: block.name, source: opts.usageSource });
    return { type: 'tool_result', tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) };
  };

  try {
    for (let round = 0; round < maxToolRounds; round++) {
      if (signal.aborted) return { response, model, aborted: true, messages };

      const result = await sendMessage({
        system: opts.system,
        messages,
        ...(toolSchemas.length > 0 ? { tools: toolSchemas } : {}),
        config: { model, provider, maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS },
        signal,
      });

      if (result.usage) {
        result.usage.model = result.usage.model ?? model;
        try {
          usageTracker.record({
            source: opts.usageSource,
            model: result.usage.model ?? model,
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
            cache_read_input_tokens: result.usage.cache_read_input_tokens,
          });
        } catch { /* accounting must never fail the run */ }
        opts.callbacks?.onUsage?.(result.usage);
      }

      if (result.aborted) {
        if (result.content.length > 0) {
          messages.push({ role: 'assistant', content: result.content } as MessageParam);
          for (const block of result.content) {
            if (block.type === 'text') response += block.text;
          }
        }
        return { response, model, aborted: true, messages };
      }

      const textParts: string[] = [];
      const toolUseBlocks: ToolUseBlock[] = [];
      for (const block of result.content) {
        if (block.type === 'thinking') {
          const thinking = (block as { type: 'thinking'; thinking: string }).thinking;
          if (thinking.trim()) opts.callbacks?.onThinking?.(thinking);
        } else if (block.type === 'text') {
          textParts.push(block.text);
          opts.callbacks?.onText?.(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block as ToolUseBlock);
        }
      }
      messages.push({ role: 'assistant', content: result.content } as MessageParam);
      if (textParts.length > 0) response += (response ? '\n' : '') + textParts.join('\n');

      if (toolUseBlocks.length === 0) return { response, model, aborted: false, messages };

      // A batch where EVERY tool is parallelSafe (read-only, no ordering
      // contract) runs concurrently — a model batching six search variants in
      // one reply should pay ONE search latency, not six. Any unmarked tool in
      // the batch forces the sequential path (side-effecting tools may race).
      // Promise.all keeps tool_result order aligned with the tool_use order.
      const canParallelize = toolUseBlocks.length > 1
        && toolUseBlocks.every((b) => tools.find((t) => t.name === b.name)?.parallelSafe === true);
      let toolResults: ToolResultBlock[];
      if (canParallelize) {
        toolResults = await Promise.all(toolUseBlocks.map(runOneToolUse));
      } else {
        toolResults = [];
        for (const block of toolUseBlocks) toolResults.push(await runOneToolUse(block));
      }
      messages.push({ role: 'user', content: toolResults as MessageParam['content'] });

      if (signal.aborted) return { response, model, aborted: true, messages };
    }

    // Rounds exhausted with the model still calling tools. Say so in the
    // response rather than returning the last partial text as if it were an
    // answer: the caller's summary line is what a human reads.
    log.agent.warn('micro agent exhausted its tool rounds', {
      source: opts.usageSource, maxToolRounds, model,
    });
    response += `${response ? '\n\n' : ''}[Tool limit reached (${maxToolRounds} rounds) before a final answer.]`;
    return { response, model, aborted: false, messages };
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
