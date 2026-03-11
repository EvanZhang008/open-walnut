/**
 * Agent loop: prompt → API call → tool execution → feed back → repeat.
 */
import { sendMessageStream, DEFAULT_MODEL, type MessageParam, type Tool, type TextBlockParam, type UsageStats, type ModelConfig, type ModelResult } from './model.js';
import { getToolSchemas, executeTool, type ToolDefinition, type ToolResultContent } from './tools.js';
import { buildSystemPrompt } from './context.js';
import { getConfig } from '../core/config-manager.js';
import {
  toSystemBlocks,
  addToolCacheMarker,
  injectMessageCacheMarkers,
  pruneContext,
  cacheTTLTracker,
} from './cache.js';
import type { CacheConfig } from '../core/types.js';
import { log } from '../logging/index.js';
import { estimateMessagesTokens, estimateFullPayload } from '../core/daily-log.js';
import { hydrateImagePaths } from '../core/chat-history.js';
import { guardBudget, emergencyTrim, type ToolSchema } from './token-budget.js';
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
): {
  system: string | TextBlockParam[];
  tools: Tool[];
  messages: MessageParam[];
} {
  const enabled = cacheConfig?.enabled !== false; // default: true

  if (!enabled) {
    return { system, tools, messages };
  }

  // Prune context if enabled AND cache TTL has expired
  let processedMessages = messages;
  if (cacheConfig?.pruneEnabled && !cacheTTLTracker.isWithinTTL()) {
    processedMessages = pruneContext(messages, cacheConfig.pruneOptions);
  }

  return {
    system: toSystemBlocks(system),
    tools: addToolCacheMarker(tools),
    messages: injectMessageCacheMarkers(processedMessages),
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
): Promise<{ messages: MessageParam[]; response: string; aborted?: boolean; tokenBreakdown?: { system: number; tools: number; messages: number; total: number } }> {
  const config = await getConfig();

  // Use custom system/tools/model if provided (subagent mode), else defaults
  const system = options?.system ?? await buildSystemPrompt();
  const customTools = options?.tools;
  const toolSchemas = customTools
    ? customTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) as Tool[]
    : getToolSchemas() as Tool[];
  // NB: undefined would default to caching ON in prepareWithCache (enabled !== false → true).
  // Convert the `false` sentinel to an explicit disabled config object.
  const cacheConfig = options?.cacheConfig === false
    ? { enabled: false } as CacheConfig
    : (options?.cacheConfig ?? config.agent?.cache);

  // Inject current date/time into first user message (not system prompt, to preserve cache)
  const now = new Date();
  const dateTimePrefix = `[Current: ${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}]\n\n`;
  const prefixedMessage = typeof userMessage === 'string'
    ? dateTimePrefix + userMessage
    : [{ type: 'text', text: dateTimePrefix } as unknown, ...userMessage];

  let messages: MessageParam[] = [
    ...history,
    { role: 'user', content: prefixedMessage } as MessageParam,
  ];

  const modelConfig: ModelConfig = options?.modelConfig ?? {
    model: config.agent?.main_model ?? config.agent?.model,
    provider: config.agent?.main_provider,
    region: config.agent?.region,
    maxTokens: config.agent?.maxTokens,
  };

  const maxToolRounds = options?.maxToolRounds ?? MAX_TOOL_ROUNDS;
  const signal = options?.signal;
  const logTag = options?.source ?? (options?.system ? 'subagent' : 'agent');

  // Log token breakdown before the loop starts; also capture fixed overhead for 400 recovery.
  const initialBreakdown = estimateFullPayload({ system, tools: toolSchemas as ToolSchema[], messages });
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
    const meta = toolUseId ? { toolUseId } : undefined;
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
    const prepared = prepareWithCache(system, toolSchemas, hydratedMessages, cacheConfig);
    // Always use streaming — non-streaming bedrock.messages.create() can timeout
    // on models that produce long responses (e.g. embedded subagents).
    return sendMessageStream({
      system: prepared.system,
      messages: prepared.messages,
      tools: prepared.tools,
      config: modelConfig,
      signal,
      onTextDelta: callbacks?.onTextDelta,
    });
  }

  let finalText = '';

  for (let round = 0; round < maxToolRounds; round++) {
    // Abort checkpoint 1: before calling model
    if (signal?.aborted) {
      log.agent.info(`${logTag} aborted before round ${round + 1}`);
      return { messages, response: finalText, aborted: true, tokenBreakdown: buildTokenBreakdown() };
    }

    // Compute token estimate: use exact baseline from last API response + estimated delta for
    // new messages. Falls back to full estimation when no baseline exists (round 0).
    let tokenEstimate: number | undefined;
    if (lastExactTokens !== null) {
      const newMessages = messages.slice(lastExactMessageCount);
      tokenEstimate = lastExactTokens + estimateMessagesTokens(newMessages);
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
        system,
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
          system, tools: toolSchemas as ToolSchema[], messages,
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
        messages.push({ role: 'assistant', content: result.content });
        for (const block of result.content) {
          if (block.type === 'text') finalText += block.text;
        }
      }
      return { messages, response: finalText, aborted: true, tokenBreakdown: buildTokenBreakdown() };
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
        callbacks?.onThinking?.((block as { type: 'thinking'; thinking: string }).thinking);
      } else if (block.type === 'text') {
        textParts.push(block.text);
        callbacks?.onText?.(block.text);
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> });
      }
    }

    // Add assistant message to history
    messages.push({ role: 'assistant', content: result.content });

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
          messages.push({ role: 'user', content: 'Continue.' });

          const contResult = await callModel();

          // Abort checkpoint: continuation call was aborted
          if (contResult.aborted) {
            if (contResult.content.length > 0) {
              messages.push({ role: 'assistant', content: contResult.content });
              for (const block of contResult.content) {
                if (block.type === 'text') finalText += block.text;
              }
            }
            return { messages, response: finalText, aborted: true, tokenBreakdown: buildTokenBreakdown() };
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

          messages.push({ role: 'assistant', content: contResult.content });
          finalText += contTextParts.join('\n');

          if (contResult.stopReason !== 'max_tokens') break;
        }
      }

      break;
    }

    // Execute tool calls and build tool_result blocks
    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: ToolResultContent }> = [];
    for (const toolUse of toolUseBlocks) {
      // Abort checkpoint 3: before each tool execution
      if (signal?.aborted) {
        log.agent.info(`${logTag} aborted, skipping tool: ${toolUse.name}`);
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: '[Aborted by user]' });
        continue;
      }

      log.agent.debug(`${logTag} calling tool: ${toolUse.name}`, {
        toolName: toolUse.name,
        inputKeys: Object.keys(toolUse.input),
      });
      callbacks?.onToolActivity?.({ toolName: toolUse.name, status: 'calling' });
      callbacks?.onToolCall?.(toolUse.name, toolUse.input, toolUse.id);

      const toolResult = await executeToolLocal(toolUse.name, toolUse.input, toolUse.id);

      callbacks?.onToolActivity?.({ toolName: toolUse.name, status: 'done' });
      // For the callback (WS broadcast to frontend), send a display-safe string.
      // Full structured content (with base64 images) goes only to the model.
      const displayResult = typeof toolResult === 'string'
        ? toolResult
        : toolResult.map(b => b.type === 'text' ? (b as { text: string }).text : '[image]').join('\n');
      callbacks?.onToolResult?.(toolUse.name, displayResult, toolUse.id);

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: toolResult,
      });
    }

    // Feed tool results back to the model
    // Cast needed: ToolResultContent uses a loose type for flexibility, but the SDK
    // expects specific union types. The actual values produced by tools conform.
    messages.push({ role: 'user', content: toolResults as MessageParam['content'] });

    // If aborted during tool execution, stop the loop
    if (signal?.aborted) {
      if (textParts.length > 0) finalText += textParts.join('\n');
      return { messages, response: finalText, aborted: true, tokenBreakdown: buildTokenBreakdown() };
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
    messages.push({
      role: 'user',
      content: `[System: You have used all ${maxToolRounds} tool rounds. You cannot call any more tools. Respond to the user with what you have so far.]`,
    } as MessageParam);

    const prepared = prepareWithCache(system, [], messages, cacheConfig); // empty tools array
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
    messages.push({ role: 'assistant', content: finalResult.content });
    finalText += closingParts.join('\n');

    log.agent.info(`${logTag} final response after max rounds`, { textLength: finalText.length });
  }

  return { messages, response: finalText, tokenBreakdown: buildTokenBreakdown() };
}
