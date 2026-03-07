/**
 * Anthropic Messages protocol adapter.
 *
 * Uses @anthropic-ai/sdk for direct Anthropic API access.
 * Also works for Anthropic-protocol compatible providers (MiniMax, Xiaomi, Cloudflare)
 * via base_url override.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import type { ApiProtocol, ProtocolAdapter, AdapterCallOptions, ModelResult } from './types.js';
import {
  MAX_RETRIES, isRetryableError, getRetryDelay, sleep,
  abortedResult, extractUsage,
} from './retry.js';
import { DEFAULT_BASE_URLS } from './defaults.js';
import { log } from '../../logging/index.js';

export class AnthropicAdapter implements ProtocolAdapter {
  readonly protocol: ApiProtocol = 'anthropic-messages';
  private client: Anthropic | null = null;
  private lastConfig: string | null = null;

  private getClient(apiKey?: string, baseUrl?: string, authHeader?: boolean): Anthropic {
    // Recreate if config changed (use key suffix to avoid storing full secret)
    const configKey = `${apiKey?.slice(-6) ?? ''}:${baseUrl}:${authHeader}`;
    if (this.client && this.lastConfig === configKey) return this.client;

    const opts: ConstructorParameters<typeof Anthropic>[0] = {};
    if (apiKey) opts.apiKey = apiKey;
    if (baseUrl) opts.baseURL = baseUrl;
    else opts.baseURL = DEFAULT_BASE_URLS['anthropic-messages'];

    // Some Anthropic-compat providers use Authorization header instead of x-api-key
    if (authHeader && apiKey) {
      opts.defaultHeaders = { Authorization: `Bearer ${apiKey}` };
    }

    this.client = new Anthropic(opts);
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
      const client = this.getClient(
        providerConfig.api_key,
        providerConfig.base_url,
        providerConfig.auth_header,
      );
      try {
        const response = await client.messages.create(
          {
            model: opts.model,
            max_tokens: opts.maxTokens,
            system: opts.system,
            messages: opts.messages,
            tools: opts.tools,
          },
          opts.signal ? { signal: opts.signal } : undefined,
        );

        return { content: response.content, stopReason: response.stop_reason, usage: extractUsage(response.usage) };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult();
        if (isRetryableError(err) && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, err);
          log.agent.warn(`anthropic 429/529 on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
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
        const client = this.getClient(
          providerConfig.api_key,
          providerConfig.base_url,
          providerConfig.auth_header,
        );
        const stream: MessageStream = client.messages.stream({
          model: opts.model,
          max_tokens: opts.maxTokens,
          system: opts.system,
          messages: opts.messages,
          tools: opts.tools,
        });

        if (opts.signal) {
          if (opts.signal.aborted) {
            stream.abort();
          } else {
            opts.signal.addEventListener('abort', () => stream.abort(), { once: true });
          }
        }

        stream.on('text', (textDelta: string) => {
          accumulatedText += textDelta;
          opts.onTextDelta?.(textDelta);
        });

        const finalMsg = await stream.finalMessage();
        return {
          content: finalMsg.content,
          stopReason: finalMsg.stop_reason,
          usage: extractUsage(finalMsg.usage),
        };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult(accumulatedText);
        if (isRetryableError(err) && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, err);
          log.agent.warn(`anthropic 429/529 on stream attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
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
