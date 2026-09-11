/**
 * Ollama protocol adapter.
 *
 * Ollama exposes an OpenAI-compatible endpoint at /v1/chat/completions,
 * so we reuse the `openai` SDK pointed at the local Ollama server.
 * No API key is required.
 *
 * Translates between Walnut's Anthropic-style internal types and OpenAI chat format.
 */
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import type {
  ApiProtocol, ProtocolAdapter, AdapterCallOptions, ModelResult,
  ContentBlock, MessageParam, Tool, UsageStats,
} from './types.js';
import { MAX_RETRIES, sleep, abortedResult } from './retry.js';
import { DEFAULT_BASE_URLS } from './defaults.js';
import { log } from '../../logging/index.js';

// ── Message conversion helpers (same as OpenAI adapter) ──

function buildSystemMessage(system: AdapterCallOptions['system']): ChatCompletionMessageParam | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return { role: 'system', content: system };
  const text = system.map(b => b.text).join('\n');
  return text ? { role: 'system', content: text } : undefined;
}

function convertMessages(messages: MessageParam[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        const textParts: string[] = [];
        for (const block of msg.content as any[]) {
          if (block.type === 'tool_result') {
            if (textParts.length) {
              result.push({ role: 'user', content: textParts.join('\n') });
              textParts.length = 0;
            }
            const toolContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: any) => c.text ?? JSON.stringify(c)).join('\n')
                : JSON.stringify(block.content ?? '');
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: toolContent,
            });
          } else if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'image') {
            textParts.push('[image]');
          }
        }
        if (textParts.length) {
          result.push({ role: 'user', content: textParts.join('\n') });
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else {
        const textParts: string[] = [];
        const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

        for (const block of msg.content as any[]) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        result.push({
          role: 'assistant',
          content: textParts.join('\n') || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        } as ChatCompletionMessageParam);
      }
    }
  }

  return result;
}

function convertTools(tools?: Tool[]): ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

function convertResponse(choice: OpenAI.Chat.Completions.ChatCompletion.Choice): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (choice.message.content) {
    blocks.push({ type: 'text', text: choice.message.content } as ContentBlock);
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      // SDK models tool_calls as a union (function | custom). We only emit
      // function tools, so skip any custom-tool variant that lacks `.function`.
      if (tc.type !== 'function') continue;
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.function.arguments); } catch { /* empty */ }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      } as unknown as ContentBlock);
    }
  }

  return blocks;
}

function mapStopReason(reason: string | null): string | null {
  if (!reason) return null;
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    default: return 'end_turn';
  }
}

function extractOllamaUsage(usage?: OpenAI.Completions.CompletionUsage): UsageStats | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
  };
}

// ── Retry helpers ──

function isRetryableOllama(err: unknown): boolean {
  if (err instanceof OpenAI.RateLimitError) return true;
  if (err instanceof OpenAI.APIError && (err.status === 503 || err.status === 529)) return true;
  // Connection refused — Ollama server may be starting up
  const msg = (err as Error)?.message ?? '';
  if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) return true;
  return false;
}

// ── Adapter ──

export class OllamaAdapter implements ProtocolAdapter {
  readonly protocol: ApiProtocol = 'ollama';
  private client: OpenAI | null = null;
  private lastConfig: string | null = null;

  private getClient(baseUrl?: string): OpenAI {
    const ollamaBase = baseUrl ?? DEFAULT_BASE_URLS['ollama'] ?? 'http://localhost:11434';
    // Ollama OpenAI-compatible endpoint is at /v1
    const configKey = ollamaBase;
    if (this.client && this.lastConfig === configKey) return this.client;

    this.client = new OpenAI({
      apiKey: 'ollama',  // Ollama ignores API key but SDK requires non-empty
      baseURL: `${ollamaBase}/v1`,
    });
    this.lastConfig = configKey;
    return this.client;
  }

  resetClient(): void {
    this.client = null;
    this.lastConfig = null;
  }

  async sendMessage(opts: AdapterCallOptions): Promise<ModelResult> {
    const { providerConfig } = opts;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const client = this.getClient(providerConfig.base_url);
      try {
        const systemMsg = buildSystemMessage(opts.system);
        const messages = convertMessages(opts.messages);
        if (systemMsg) messages.unshift(systemMsg);

        const response = await client.chat.completions.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          messages,
          tools: convertTools(opts.tools),
          stream: false,
        }, opts.signal ? { signal: opts.signal } : undefined);

        const choice = response.choices[0];
        return {
          content: convertResponse(choice),
          stopReason: mapStopReason(choice.finish_reason),
          usage: extractOllamaUsage(response.usage),
        };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult();
        if (isRetryableOllama(err) && attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
          log.agent.warn(`ollama error on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
          await sleep(delay, opts.signal);
          if (opts.signal?.aborted) return abortedResult();
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable: retry loop exhausted');
  }

  async sendMessageStream(
    opts: AdapterCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<ModelResult> {
    const { providerConfig } = opts;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let accumulatedText = '';

      try {
        const client = this.getClient(providerConfig.base_url);
        const systemMsg = buildSystemMessage(opts.system);
        const messages = convertMessages(opts.messages);
        if (systemMsg) messages.unshift(systemMsg);

        const stream = await client.chat.completions.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          messages,
          tools: convertTools(opts.tools),
          stream: true,
        }, opts.signal ? { signal: opts.signal } : undefined);

        const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
        let finishReason: string | null = null;
        let usage: OpenAI.Completions.CompletionUsage | undefined;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          const reason = chunk.choices[0]?.finish_reason;
          if (reason) finishReason = reason;
          if (chunk.usage) usage = chunk.usage;

          if (delta?.content) {
            accumulatedText += delta.content;
            opts.onTextDelta?.(delta.content);
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
              }
              const buf = toolCallBuffers.get(idx)!;
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name = tc.function.name;
              if (tc.function?.arguments) buf.args += tc.function.arguments;
            }
          }
        }

        const content: ContentBlock[] = [];
        if (accumulatedText) {
          content.push({ type: 'text', text: accumulatedText } as ContentBlock);
        }
        for (const [, buf] of toolCallBuffers) {
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(buf.args); } catch { /* empty */ }
          content.push({
            type: 'tool_use',
            id: buf.id,
            name: buf.name,
            input,
          } as unknown as ContentBlock);
        }

        return {
          content,
          stopReason: mapStopReason(finishReason),
          usage: extractOllamaUsage(usage),
        };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult(accumulatedText);
        if (isRetryableOllama(err) && attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
          log.agent.warn(`ollama error on stream attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
          await sleep(delay, opts.signal);
          if (opts.signal?.aborted) return abortedResult();
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable: retry loop exhausted');
  }
}
