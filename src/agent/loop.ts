/**
 * Agent loop: prompt → API call → tool execution → feed back → repeat.
 */
import { sendMessageStream, DEFAULT_MODEL, type MessageParam, type Tool, type TextBlockParam, type UsageStats, type ModelConfig, type ModelResult } from './model.js';
import { getToolSchemas, executeTool, type ToolDefinition, type ToolResultContent, type ToolExecuteMeta } from './tools.js';
import { buildSystemPromptSplit } from './context.js';
import { getConfig } from '../core/config-manager.js';
import {
  toSystemBlocks,
  addToolCacheMarker,
  injectMessageCacheMarkers,
  appendEphemeralContext,
  pruneContext,
  cacheTTLTracker,
} from './cache.js';
import type { CacheConfig } from '../core/types.js';
import { log } from '../logging/index.js';
import { estimateMessagesTokens, estimateFullPayload } from '../core/daily-log.js';
import { hydrateImagePaths } from '../core/chat-history.js';
import { guardBudget, emergencyTrim, type ToolSchema } from './token-budget.js';
import { beginMemoryPromptTurn, getBoundedMemory } from '../core/bounded-memory.js';
import { observe, count } from '../core/observability/metrics.js';
import { buildSkillPrefetchHint } from './skill-prefetch.js';
import { getContextWindowSize } from './model.js';
import { CONTEXT_WINDOW_DEFAULT } from './providers/defaults.js';

export interface ToolActivity {
  toolName: string;
  status: 'calling' | 'done';
}

export interface AgentCallbacks {
  onText?: (text: string) => void;
  onTextDelta?: (delta: string) => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onThinking?: (text: string) => void;
  onToolCall?: (toolName: string, input: Record<string, unknown>, toolUseId: string) => void;
  onToolResult?: (toolName: string, result: string, toolUseId: string) => void;
  onUsage?: (usage: UsageStats) => void;
}

export interface AgentLoopOptions {
  /** Custom system prompt. If not provided, uses buildSystemPrompt(). */
  system?: string;
  /** Custom tool set. If not provided, uses global tools. */
  tools?: ToolDefinition[];
  /** Model configuration overrides. */
  modelConfig?: ModelConfig;
  /** Max tool execution rounds. Default: 10. */
  maxToolRounds?: number;
  /** Whether to use prompt caching. Default: true (uses config). Set to false to disable. */
  cacheConfig?: CacheConfig | false;
  /** AbortSignal to cancel the loop. When aborted, the loop finishes the current tool then stops. */
  signal?: AbortSignal;
  /** Caller identity for logging (e.g. 'chat', 'cron', 'triage', 'cli'). */
  source?: string;
  /** Conversation this turn runs for. Used to build the system prompt's
   *  "Earlier conversation context" from the RIGHT conversation's compaction
   *  summary + working memory. Omit only when `system` is supplied explicitly. */
  agentId?: string;
  conversationId?: string;
  /** RUNTIME tool dispatch whitelist (background review fork). The full tool
   *  schema is still sent to the API — shrinking tools[] would change the
   *  prompt-cache key and bust the warm prefix — but any call to a tool not
   *  in this list is denied at execution time. */
  toolWhitelist?: string[];
}

const MAX_TOOL_ROUNDS = 300;
const MAX_CONTINUATION_ROUNDS = 3;

/**
 * Detect Bedrock 400 "prompt is too long" errors and extract the actual token count.
 * Returns the reported token count, or null if the error is not this type.
 */
function is400PromptTooLong(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  // Only treat confirmed 400 responses as "too long"; ignore if status is something else.
  // (APIError from @anthropic-ai/sdk carries a .status property)
  const status = (err as { status?: number }).status;
  if (status !== undefined && status !== 400) return null;
  // e.g. "400 prompt is too long: 225938 tokens > 200000 maximum"
  const match = /prompt is too long[:\s]+(\d+)\s*tokens/i.exec(err.message);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse the API's maximum token limit from the error message.
 * e.g. "225938 tokens > 200000 maximum" → 200000
 * Used as a safety net when getContextWindowSize() returns 1M but the API
 * actually enforces a lower limit (e.g. beta header not applied).
 */
function parseMaxFromError(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = />\s*(\d+)\s*maximum/i.exec(err.message);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Prepare system prompt, tools, and messages with cache markers.
 * Returns transformed inputs ready for sendMessage().
 */
function prepareWithCache(
  system: string,
  tools: Tool[],
  messages: MessageParam[],
  cacheConfig?: CacheConfig,
  /** Volatile per-turn memory context (task counts, daily logs, the
   *  per-conversation compaction summary). Injected at the END of the message
   *  array — AFTER the message cache breakpoint — so it never busts the cached
   *  prefix (tools + stable system + the whole prior message history). Ephemeral:
   *  injected only into the transient send array, never persisted. See
   *  appendEphemeralContext(). */
  dynamicContext?: string,
): {
  system: string | TextBlockParam[];
  tools: Tool[];
  messages: MessageParam[];
} {
  const enabled = cacheConfig?.enabled !== false; // default: true

  if (!enabled) {
    // No caching, but the volatile context must still reach the model — append it
    // to the message tail (same placement, just no cache markers).
    const merged = dynamicContext ? appendEphemeralContext(messages, dynamicContext) : messages;
    return { system, tools, messages: merged };
  }

  // Prune context if enabled AND cache TTL has expired
  let processedMessages = messages;
  if (cacheConfig?.pruneEnabled && !cacheTTLTracker.isWithinTTL()) {
    processedMessages = pruneContext(messages, cacheConfig.pruneOptions);
  }

  // Order matters: mark the cache breakpoint on the last REAL (persisted) message
  // FIRST, then append the ephemeral context past it. The volatile block thus lands
  // after the breakpoint and never enters the cached prefix.
  let preparedMessages = injectMessageCacheMarkers(processedMessages);
  if (dynamicContext) {
    preparedMessages = appendEphemeralContext(preparedMessages, dynamicContext);
  }

  return {
    system: toSystemBlocks(system),
    tools: addToolCacheMarker(tools),
    messages: preparedMessages,
  };
}

/**
 * Run the agent loop for a single user turn.
 * Takes existing conversation history, appends the user message,
 * and runs tool calls until the model produces a final text response.
 *
 * When `options` is provided (subagent mode), uses custom system prompt,
 * tools, model config, and max rounds instead of the defaults.
 *
 * Returns the updated messages array and the final assistant text.
 */
export async function runAgentLoop(
  userMessage: string | unknown[],
  history: MessageParam[],
  callbacks?: AgentCallbacks,
  options?: AgentLoopOptions,
): Promise<{ messages: MessageParam[]; newMessages: MessageParam[]; response: string; aborted?: boolean; tokenBreakdown?: { system: number; tools: number; messages: number; total: number } }> {
  const config = await getConfig();

  // Turn boundary: the memory consolidation breaker (memory_manage writes) counts consecutive
  // failures WITHIN a turn (Hermes #42405); a new user turn resets it.
  // Personal AI turns only: subagent/cron/dream loops (options.system set) run
  // interleaved with a live main turn — resetting from them would clear the
  // breaker mid-consolidation and re-open the infinite retry loop. The global
  // memory actions always operate on the general store, so reset that one.
  // The background-review fork also runs the default-system path but is a
  // background turn interleaved with real ones — same hazard, so exclude it.
  if (options?.system === undefined && options?.source !== 'background-review') {
    getBoundedMemory().resetConsolidationFailures();
    getBoundedMemory(undefined, 'user').resetConsolidationFailures();

    // Same gate, same reason: RE-PIN the frozen memory prompt snapshot for this
    // conversation (Hermes frozen-snapshot pattern — see memory-prompt-snapshot.ts).
    // A real Personal AI turn is the ONLY thing that refreshes the pin, so a write
    // mid-turn (including one from the background-review fork, which is excluded
    // here) reaches disk immediately but only enters the prompt on the NEXT turn.
    // Reusing this gate is deliberate: one definition of "a real turn started",
    // not two that can drift apart. Best-effort — a snapshot failure must never
    // block the turn, and read-through is a correct fallback.
    try {
      const { drift } = beginMemoryPromptTurn(options?.agentId, options?.conversationId);
      for (const d of drift) {
        if (d.origin !== 'external') continue;
        // Not an error: the new bytes ARE adopted from this turn on. But these
        // paths (hand edit, file_write on a memory path, data-repo sync, the web
        // editor) bypass every write-time check, so make it visible.
        log.agent.warn('memory changed outside the memory tool; adopted this turn', {
          scope: d.scope, previousHash: d.previousHash, currentHash: d.currentHash,
          agentId: options?.agentId, conversationId: options?.conversationId,
        });
      }
    } catch (err) {
      log.agent.warn('memory prompt snapshot pin failed; reading live', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Use custom system/tools/model if provided (subagent mode), else defaults.
  // buildSystemPromptSplit is conversation-scoped so the injected "Earlier conversation
  // context" comes from THIS conversation, not the legacy ghost file.
  //
  // Split: `system` = stable, cacheable prefix (role/sync/skills/subagents);
  // `dynamicContext` = volatile memory context (task counts, daily logs, the
  // per-conversation compaction summary). The volatile part is injected at the END of
  // the message array (after the cache breakpoint), NOT in the system prompt — so the
  // cached prefix (tools + stable system + the WHOLE prior message history) stays
  // byte-identical across turns and keeps hitting. Subagent mode supplies its own
  // `system` and has no dynamic part.
  let system: string;
  let dynamicContext: string | undefined;
  if (options?.system !== undefined) {
    system = options.system;
  } else {
    // Skill prefetch runs CONCURRENTLY with prompt building and is capped at
    // 300ms — it sits on the send hot path, and an unbounded search here would
    // stall first-token latency. Timeout/error → no hint. (The keyword lane it
    // uses now answers in single-digit ms, so the cap is headroom, not a race.)
    const hintPromise: Promise<string | null> = typeof userMessage === 'string'
      ? Promise.race([
          buildSkillPrefetchHint(userMessage),
          new Promise<null>((resolve) => setTimeout(resolve, 300, null)),
        ]).catch(() => null)
      : Promise.resolve(null);

    const split = await buildSystemPromptSplit(options?.agentId, options?.conversationId);
    system = split.stable;
    dynamicContext = split.dynamic || undefined;

    // Volatile injection ONLY — the stable prefix above must stay byte-identical
    // across turns or the prompt cache busts.
    const hint = await hintPromise;
    if (hint) dynamicContext = dynamicContext ? `${dynamicContext}\n\n${hint}` : hint;
  }
  const customTools = options?.tools;
  const toolSchemas = customTools
    ? customTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) as Tool[]
    : getToolSchemas() as Tool[];
  // NB: undefined would default to caching ON in prepareWithCache (enabled !== false → true).
  // Convert the `false` sentinel to an explicit disabled config object.
  const cacheConfig = options?.cacheConfig === false
    ? { enabled: false } as CacheConfig
    : (options?.cacheConfig ?? config.agent?.cache);

  // Inject current date/time. Placement differs by path, and the difference is
  // load-bearing for the prompt cache:
  //
  // - DEFAULT (Personal AI) path: the date rides the DYNAMIC CONTEXT block, never the
  //   user message. It used to be prefixed onto the SENT user message — but the
  //   persisted copy (chat.ts eager-persist) is the RAW message, so on the next
  //   turn the replayed history never byte-matched the cached prefix and the
  //   ENTIRE message-history cache was re-written every turn. Measured (usage DB,
  //   2026-08-13): cross-turn cache_read pinned at 38K (= system+tools only)
  //   while cache_creation grew 334K→614K per turn — a 2x-write bill on the whole
  //   history, every turn, forever. The dynamic block already sits past the cache
  //   breakpoint and changes per turn, so the timestamp is free there.
  //
  // - SUBAGENT path (options.system set): keep prefixing the user message. There
  //   is no dynamic block to carry the date, and subagent history lives in memory
  //   (replayed byte-identically within the run), so the mismatch class above
  //   does not exist there.
  const now = new Date();
  const currentDateTime = `[Current: ${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}]`;
  let userTurnMessage: MessageParam;
  if (options?.system !== undefined) {
    const prefixedMessage = typeof userMessage === 'string'
      ? `${currentDateTime}\n\n${userMessage}`
      : [{ type: 'text', text: `${currentDateTime}\n\n` } as unknown, ...userMessage];
    userTurnMessage = { role: 'user', content: prefixedMessage } as MessageParam;
  } else {
    dynamicContext = dynamicContext ? `${currentDateTime}\n\n${dynamicContext}` : currentDateTime;
    userTurnMessage = { role: 'user', content: userMessage } as MessageParam;
  }
  let messages: MessageParam[] = [
    ...history,
    userTurnMessage,
  ];

  // Messages produced THIS turn (user prompt + every assistant/tool message).
  // Tracked independently of `messages` so that emergency trim / budget guard —
  // which delete OLD history from the FRONT of `messages` — can never corrupt the
  // "what's new this turn" slice. Callers persist this instead of the fragile
  // `result.messages.slice(history.length)` (which overshoots after a trim shortens
  // the array, silently dropping the assistant reply — the root cause of the
  // duplicate-task / orphaned-message bug).
  const newMessages: MessageParam[] = [userTurnMessage];
  /** Append a this-turn message to BOTH the working array and the new-messages accumulator. */
  const pushTurnMessage = (msg: MessageParam): void => {
    messages.push(msg);
    newMessages.push(msg);
  };

  const modelConfig: ModelConfig = options?.modelConfig ?? {
    model: config.agent?.main_model ?? config.agent?.model,
    provider: config.agent?.main_provider,
    region: config.agent?.region,
    maxTokens: config.agent?.maxTokens,
  };

  const maxToolRounds = options?.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const signal = options?.signal;
  const logTag = options?.source ?? (options?.system ? 'subagent' : 'agent');

  // Token accounting: the volatile context IS sent every turn (just on the message tail,
  // not in system), so its tokens must be counted. Folding it into the system string for
  // estimation purposes is the simplest correct accounting — the estimator only sums
  // buckets, and the dynamic token count is the same wherever it physically rides.
  const systemForEstimate = dynamicContext ? `${system}\n\n${dynamicContext}` : system;

  // Log token breakdown before the loop starts; also capture fixed overhead for 400 recovery.
  const initialBreakdown = estimateFullPayload({ system: systemForEstimate, tools: toolSchemas as ToolSchema[], messages });
  log.agent.info(`${logTag} loop start`, {
    source: logTag,
    systemTokens: `~${Math.round(initialBreakdown.system / 1000)}K`,
    toolCount: toolSchemas.length,
    toolsTokens: `~${Math.round(initialBreakdown.tools / 1000)}K`,
    historyMessages: messages.length,
    messageTokens: `~${Math.round(initialBreakdown.messages / 1000)}K`,
    estimatedTotal: `~${Math.round(initialBreakdown.total / 1000)}K`,
  });
  // system+tools overhead is fixed for the lifetime of this loop (used in 400 recovery)
  const fixedOverhead = initialBreakdown.system + initialBreakdown.tools;

  // Exact input-token count from the last successful API call (system + tools + messages).
  // Used as a reliable baseline for per-round budget estimation (baseline + delta).
  let lastExactTokens: number | null = null;
  let lastExactMessageCount = 0;

  /** Build token breakdown from the most accurate data available. */
  function buildTokenBreakdown() {
    return {
      system: initialBreakdown.system,
      tools: initialBreakdown.tools,
      messages: lastExactTokens !== null
        ? lastExactTokens - fixedOverhead
        : initialBreakdown.messages,
      total: lastExactTokens ?? initialBreakdown.total,
    };
  }

  /** Execute a tool by name — uses custom tool set if provided. */
  async function executeToolLocal(name: string, params: Record<string, unknown>, toolUseId?: string): Promise<ToolResultContent> {
    // `source` rides along so write-path telemetry can tell a live turn from the
    // unattended background-review fork (memory entry provenance).
    const metaFields: ToolExecuteMeta = { ...(toolUseId ? { toolUseId } : {}), ...(options?.source ? { source: options.source } : {}) };
    const meta = Object.keys(metaFields).length > 0 ? metaFields : undefined;
    // Runtime dispatch whitelist (background review fork): full schemas were sent
    // to the API to keep the prompt-cache prefix byte-identical, but only the
    // whitelisted tools may actually run.
    if (options?.toolWhitelist && !options.toolWhitelist.includes(name)) {
      return `Error: Tool "${name}" is not available in this review pass. Allowed tools: ${options.toolWhitelist.join(', ')}. Use ONLY the allowed tools; do not retry others.`;
    }
    if (customTools) {
      const tool = customTools.find((t) => t.name === name);
      if (!tool) return `Error: Unknown tool "${name}"`;
      try {
        return await tool.execute(params, meta);
      } catch (err) {
        return `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return executeTool(name, params, meta);
  }

  /** Send current messages through cache preparation and API call. */
  async function callModel(): Promise<ModelResult> {
    // Hydrate path-based images to base64 before sending to the API
    const hydratedMessages = await hydrateImagePaths(messages);
    const prepared = prepareWithCache(system, toolSchemas, hydratedMessages, cacheConfig, dynamicContext);
    // Always use streaming — non-streaming bedrock.messages.create() can timeout
    // on models that produce long responses (e.g. embedded subagents).
    const llmStart = performance.now();
    const result = await sendMessageStream({
      system: prepared.system,
      messages: prepared.messages,
      tools: prepared.tools,
      config: modelConfig,
      signal,
      onTextDelta: callbacks?.onTextDelta,
    });
    // Metric: one LLM round-trip (request → full stream drained). The cache
    // counters make cross-turn cache regressions (the [Current:] prefix bug
    // class) visible as a ratio shift instead of a silent 2x bill.
    observe('llm.roundtrip', performance.now() - llmStart, { source: logTag });
    if (result.usage) {
      count('llm.tokens.input', result.usage.input_tokens ?? 0, { source: logTag });
      count('llm.tokens.output', result.usage.output_tokens ?? 0, { source: logTag });
      count('llm.tokens.cache_read', result.usage.cache_read_input_tokens ?? 0, { source: logTag });
      count('llm.tokens.cache_write', result.usage.cache_creation_input_tokens ?? 0, { source: logTag });
    }
    return result;
  }

  let finalText = '';

  for (let round = 0; round < maxToolRounds; round++) {
    // Abort checkpoint 1: before calling model
    if (signal?.aborted) {
      log.agent.info(`${logTag} aborted before round ${round + 1}`);
      return { messages, newMessages, response: finalText, aborted: true, tokenBreakdown: buildTokenBreakdown() };
    }

    // Compute token estimate: use exact baseline from last API response + estimated delta for
    // new messages. Falls back to full estimation when no baseline exists (round 0).
    let tokenEstimate: number | undefined;
    if (lastExactTokens !== null) {
      // NB: distinct from the outer `newMessages` accumulator — this is just the
      // messages added since the last exact API baseline, for the delta estimate.
      const messagesSinceBaseline = messages.slice(lastExactMessageCount);
      tokenEstimate = lastExactTokens + estimateMessagesTokens(messagesSinceBaseline);
    }

    log.agent.info(`${logTag} round ${round + 1}/${maxToolRounds}`, {
      toolRound: round + 1,
      messageCount: messages.length,
      estimatedTokens: tokenEstimate !== undefined
        ? `~${Math.round(tokenEstimate / 1000)}K`
        : `~${Math.round(estimateMessagesTokens(messages) / 1000)}K (msgs only)`,
    });

    // Token budget guard: run every round using the fast baseline+delta estimate.
    // Falls through to full estimateFullPayload only on round 0 or when over budget.
    {
      const budgetResult = await guardBudget({
        system: systemForEstimate,
        tools: toolSchemas as ToolSchema[],
        messages,
        source: logTag,
        tokenEstimate,
        model: modelConfig.model,
      });
      if (budgetResult.trimmed) {
        messages = budgetResult.messages;
        // Baseline is stale after trim — force full estimation next round
        lastExactTokens = null;
        lastExactMessageCount = 0;
      }
    }

    // Call model with 400 "prompt too long" recovery: parse actual count, trim, retry once.
    let result: ModelResult;
    try {
      result = await callModel();
    } catch (err) {
      const actualTokens = is400PromptTooLong(err);
      if (actualTokens !== null) {
        // Use the API's reported maximum as the trim target when available.
        // This handles the case where getContextWindowSize() returns 1M but the API
        // actually enforces a lower limit (e.g. beta header not applied).
        // When we can't parse the max, fall back to 200K (safe default) instead of
        // the model's context window which could be 1M and useless as a trim target.
        const rawMax = parseMaxFromError(err);
        const parsedMax = rawMax && rawMax > 0 ? rawMax : null;
        const fallbackMax = parsedMax ?? CONTEXT_WINDOW_DEFAULT;
        const hardBudget = Math.round(fallbackMax * 0.90);

        // Calibrate trim using the API's exact token count vs our estimate.
        // Our estimator can undercount by 15-25%; using the ratio ensures we
        // trim enough so the retry actually fits under the API's hard limit.
        const currentEstimate = estimateFullPayload({
          system: systemForEstimate, tools: toolSchemas as ToolSchema[], messages,
        }).total;
        const correctionRatio = currentEstimate > 0
          ? Math.max(1.0, Math.min(actualTokens / currentEstimate, 2.0))
          : 1.3; // fallback: assume 30% underestimate

        // Convert hard budget from "real tokens" to "estimated tokens" space,
        // then subtract the (estimated) fixed overhead to get message budget.
        const adjustedMessageBudget = Math.round(hardBudget / correctionRatio) - fixedOverhead;

        log.agent.warn(`${logTag} 400 prompt too long (${actualTokens} tokens), calibrated trim and retry`, {
          actualTokens,
          apiMaximum: parsedMax ?? 'unknown (using context window)',
          currentEstimate: `~${Math.round(currentEstimate / 1000)}K`,
          correctionRatio: correctionRatio.toFixed(2),
          adjustedMessageBudget: `~${Math.round(adjustedMessageBudget / 1000)}K`,
        });
        messages = emergencyTrim(messages, Math.max(adjustedMessageBudget, 0));
        lastExactTokens = null;
        lastExactMessageCount = 0;
        result = await callModel();
      } else {
        throw err;
      }
    }

    // Abort checkpoint 2: model call was aborted
    if (result.aborted) {
      log.agent.info(`${logTag} model call aborted`);
      if (result.content.length > 0) {
        pushTurnMessage({ role: 'assistant', content: result.content });
        for (const block of result.content) {
          if (block.type === 'text') finalText += block.text;
        }
      }
      return { messages, newMessages, response: finalText, aborted: true, tokenBreakdown: buildTokenBreakdown() };
    }

    cacheTTLTracker.touch();
    if (result.usage) {
      result.usage.model = modelConfig.model ?? DEFAULT_MODEL;
      callbacks?.onUsage?.(result.usage);
      // Save exact input token count as baseline for the next round's budget estimate.
      // input_tokens = system + tools + messages (including cache overhead); all are input.
      // Note: delta is estimated on raw messages, not cache-marked ones. This slightly
      // underestimates new-message tokens, but the effect is small and 400 recovery handles overflow.
      lastExactTokens = (result.usage.input_tokens ?? 0)
        + (result.usage.cache_read_input_tokens ?? 0)
        + (result.usage.cache_creation_input_tokens ?? 0);
      lastExactMessageCount = messages.length; // saved before assistant push — delta includes [assistant, tool_results]
    } else {
      // No usage stats (e.g. some cached responses); baseline stays stale, next round falls back to full estimation.
      log.agent.debug(`${logTag} no usage stats in response, token baseline unchanged`);
    }

    // Collect text blocks and tool_use blocks from response
    const textParts: string[] = [];
    const toolUseBlocks: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = [];

    for (const block of result.content) {
      if (block.type === 'thinking') {
        const thinking = (block as { type: 'thinking'; thinking: string }).thinking;
        if (thinking.trim()) callbacks?.onThinking?.(thinking);
      } else if (block.type === 'text') {
        textParts.push(block.text);
        callbacks?.onText?.(block.text);
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> });
      }
    }

    // Add assistant message to history
    pushTurnMessage({ role: 'assistant', content: result.content });

    // If no tool calls, check if we need to continue due to max_tokens
    if (toolUseBlocks.length === 0) {
      log.agent.info(`${logTag} model stopped`, { stopReason: result.stopReason, textLength: textParts.join('').length });
      finalText += textParts.join('\n');

      // Auto-continue when response was truncated by token limit
      if (result.stopReason === 'max_tokens') {
        let continuations = 0;
        while (continuations < MAX_CONTINUATION_ROUNDS) {
          if (signal?.aborted) break;
          continuations++;
          log.agent.info(`${logTag} continuation ${continuations}/${MAX_CONTINUATION_ROUNDS}`);
          pushTurnMessage({ role: 'user', content: 'Continue.' });

          const contResult = await callModel();

          // Abort checkpoint: continuation call was aborted
          if (contResult.aborted) {
            if (contResult.content.length > 0) {
              pushTurnMessage({ role: 'assistant', content: contResult.content });
              for (const block of contResult.content) {
                if (block.type === 'text') finalText += block.text;
              }
            }
            return { messages, newMessages, response: finalText, aborted: true, tokenBreakdown: buildTokenBreakdown() };
          }

          cacheTTLTracker.touch();
          if (contResult.usage) {
            contResult.usage.model = modelConfig.model ?? DEFAULT_MODEL;
            callbacks?.onUsage?.(contResult.usage);
            // Keep baseline current through continuations (loop breaks after, but maintain invariant)
            lastExactTokens = (contResult.usage.input_tokens ?? 0)
              + (contResult.usage.cache_read_input_tokens ?? 0)
              + (contResult.usage.cache_creation_input_tokens ?? 0);
            lastExactMessageCount = messages.length;
          }

          const contTextParts: string[] = [];
          for (const block of contResult.content) {
            if (block.type === 'text') {
              contTextParts.push(block.text);
              callbacks?.onText?.(block.text);
            }
          }

          pushTurnMessage({ role: 'assistant', content: contResult.content });
          finalText += contTextParts.join('\n');

          if (contResult.stopReason !== 'max_tokens') break;
        }
      }

      break;
    }

    // Execute tool calls and build tool_result blocks
    const runOneToolUse = async (
      toolUse: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> },
    ): Promise<{ type: 'tool_result'; tool_use_id: string; content: ToolResultContent; is_error?: boolean }> => {
      // Abort checkpoint 3: before each tool execution
      if (signal?.aborted) {
        log.agent.info(`${logTag} aborted, skipping tool: ${toolUse.name}`);
        return { type: 'tool_result', tool_use_id: toolUse.id, content: '[Aborted by user]' };
      }

      log.agent.debug(`${logTag} calling tool: ${toolUse.name}`, {
        toolName: toolUse.name,
        inputKeys: Object.keys(toolUse.input),
      });
      callbacks?.onToolActivity?.({ toolName: toolUse.name, status: 'calling' });
      callbacks?.onToolCall?.(toolUse.name, toolUse.input, toolUse.id);

      const toolStart = performance.now();
      const toolResult = await executeToolLocal(toolUse.name, toolUse.input, toolUse.id);
      // Metric: per-tool latency. Tool name is a bounded set (registered tools),
      // so it's a safe label; inputs are NOT (unbounded) and never become labels.
      observe('tool.exec', performance.now() - toolStart, { tool: toolUse.name });

      callbacks?.onToolActivity?.({ toolName: toolUse.name, status: 'done' });
      // For the callback (WS broadcast to frontend), send a display-safe string.
      // Full structured content (with base64 images) goes only to the model.
      const displayResult = typeof toolResult === 'string'
        ? toolResult
        : toolResult.map(b => b.type === 'text' ? (b as { text: string }).text : '[image]').join('\n');
      callbacks?.onToolResult?.(toolUse.name, displayResult, toolUse.id);

      // Detect tool errors: all tool error paths return strings starting with "Error:"
      // or "Error executing". Setting is_error tells the model to treat it as a failure
      // and retry or report, rather than treating it as successful output.
      const isError = isToolResultError(toolResult);
      if (isError) {
        log.agent.warn(`${logTag} tool ${toolUse.name} returned error`, { displayResult });
      }

      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: toolResult,
        ...(isError ? { is_error: true } : {}),
      };
    };

    // A batch where EVERY tool is parallelSafe (read-only, no ordering
    // contract) runs concurrently — a model batching e.g. 6 search variants
    // in one reply should pay ONE search latency, not six in sequence. Any
    // unmarked tool in the batch forces the sequential path (side-effecting
    // tools may race each other). Promise.all keeps tool_result order aligned
    // with the tool_use order.
    const canParallelize = toolUseBlocks.length > 1
      && toolUseBlocks.every((t) => customTools?.find((c) => c.name === t.name)?.parallelSafe === true);
    let toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: ToolResultContent; is_error?: boolean }>;
    if (canParallelize) {
      toolResults = await Promise.all(toolUseBlocks.map(runOneToolUse));
    } else {
      toolResults = [];
      for (const toolUse of toolUseBlocks) {
        toolResults.push(await runOneToolUse(toolUse));
      }
    }

    // Feed tool results back to the model
    // Cast needed: ToolResultContent uses a loose type for flexibility, but the SDK
    // expects specific union types. The actual values produced by tools conform.
    pushTurnMessage({ role: 'user', content: toolResults as MessageParam['content'] });

    // If aborted during tool execution, stop the loop
    if (signal?.aborted) {
      if (textParts.length > 0) finalText += textParts.join('\n');
      return { messages, newMessages, response: finalText, aborted: true, tokenBreakdown: buildTokenBreakdown() };
    }

    // If there was also text in the response with tools, accumulate it
    if (textParts.length > 0) {
      finalText += textParts.join('\n');
    }
  }

  // If we exhausted max tool rounds while the model was still making tool calls,
  // make one final call WITHOUT tools so the model can produce a text summary,
  // and notify the user clearly that the limit was hit.
  const lastMsg = messages[messages.length - 1] as { role: string; content: unknown } | undefined;
  const exhaustedWithToolResults = lastMsg?.role === 'user' && Array.isArray(lastMsg.content)
    && (lastMsg.content as Array<{ type: string }>).some(b => b.type === 'tool_result');

  if (exhaustedWithToolResults && !signal?.aborted) {
    log.agent.warn(`${logTag} max tool rounds (${maxToolRounds}) exhausted, making final call without tools`);

    // Notify the user via text delta so they see it in real-time
    const notice = `\n\n---\n**Tool limit reached (${maxToolRounds} rounds).** No more tool calls available this turn.\n\n`;
    callbacks?.onTextDelta?.(notice);
    callbacks?.onText?.(notice);
    finalText += notice;

    // Give the model one final chance to respond without tools
    pushTurnMessage({
      role: 'user',
      content: `[System: You have used all ${maxToolRounds} tool rounds. You cannot call any more tools. Respond to the user with what you have so far.]`,
    } as MessageParam);

    const prepared = prepareWithCache(system, [], messages, cacheConfig, dynamicContext); // empty tools array
    const finalResult = await sendMessageStream({
      system: prepared.system,
      messages: prepared.messages,
      tools: [],         // no tools — force text response
      config: modelConfig,
      signal,
      onTextDelta: callbacks?.onTextDelta,
    });

    if (finalResult.usage) {
      finalResult.usage.model = modelConfig.model ?? DEFAULT_MODEL;
      callbacks?.onUsage?.(finalResult.usage);
    }

    const closingParts: string[] = [];
    for (const block of finalResult.content) {
      if (block.type === 'text') {
        closingParts.push(block.text);
        callbacks?.onText?.(block.text);
      }
    }
    pushTurnMessage({ role: 'assistant', content: finalResult.content });
    finalText += closingParts.join('\n');

    log.agent.info(`${logTag} final response after max rounds`, { textLength: finalText.length });
  }

  return { messages, newMessages, response: finalText, tokenBreakdown: buildTokenBreakdown() };
}

/**
 * Detect whether a tool result represents an error.
 * All tool error paths produce strings starting with "Error:" or "Error executing".
 * For structured content blocks, check the first text block.
 */
export function isToolResultError(result: ToolResultContent): boolean {
  const text = typeof result === 'string'
    ? result
    : result.find(b => b.type === 'text')
      ? (result.find(b => b.type === 'text') as { text: string }).text
      : '';
  return /^Error[:\s]/i.test(text);
}
