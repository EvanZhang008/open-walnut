/**
 * Bedrock SDK wrapper for Claude API calls.
 * Reads bearer token from config.yaml (provider.bedrock_bearer_token),
 * falls back to AWS_BEARER_TOKEN_BEDROCK env var, then standard AWS credential chain.
 * Aggressive retry on 429 (rate limit) and 529 (overloaded) errors.
 * Auto-recreates client on 403 (expired credentials).
 */
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import { RateLimitError, APIError } from '@anthropic-ai/sdk';
import type { MessageParam, ContentBlock, Tool, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import { getConfig } from '../core/config-manager.js';
import { log } from '../logging/index.js';

export type { MessageParam, ContentBlock, Tool, TextBlockParam };

export interface UsageStats {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Model ID used for this API call (populated by the agent loop). */
  model?: string;
}

export interface ModelConfig {
  model?: string;
  region?: string;
  maxTokens?: number;
}

export const DEFAULT_MODEL = 'global.anthropic.claude-opus-4-6-v1';
const DEFAULT_MAX_TOKENS = 32768;

/** Strip [1m] suffix used as context-window marker — Bedrock model ID doesn't include it. */
function resolveBedrockModelId(model: string): string {
  return model.replace(/\[1m\]$/, '');
}

// Aggressive retry config for 429/529 errors
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;  // 1s initial delay
const MAX_DELAY_MS = 60000;  // cap at 60s
const JITTER_FACTOR = 0.3;   // ±30% jitter

function isAuthError(err: unknown): boolean {
  return err instanceof APIError && err.status === 403;
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;  // 429
  if (err instanceof APIError && (err.status === 529 || err.status === 503)) return true;  // overloaded / service unavailable
  return false;
}

function getRetryDelay(attempt: number, err: unknown): number {
  // Use retry-after header if available
  if (err instanceof APIError && err.headers) {
    const retryAfter = err.headers['retry-after'];
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s, 60s
  const exponential = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = exponential * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(500, exponential + jitter);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

let client: AnthropicBedrock | null = null;

/**
 * Create a new Bedrock client. Reads bearer token from config.yaml first,
 * falls back to AWS_BEARER_TOKEN_BEDROCK env var, then standard AWS credentials.
 */
async function createClient(region?: string): Promise<AnthropicBedrock> {
  // Try config.yaml first, then env var
  let bearerToken: string | undefined;
  let configRegion: string | undefined;
  try {
    const config = await getConfig();
    bearerToken = config.provider?.bedrock_bearer_token;
    configRegion = config.provider?.bedrock_region;
  } catch {
    // Config read failed — fall through to env var
  }
  bearerToken ||= process.env.AWS_BEARER_TOKEN_BEDROCK;
  const effectiveRegion = region ?? configRegion ?? process.env.AWS_REGION ?? 'us-west-2';

  if (bearerToken) {
    // Bearer token auth: skip SigV4, pass token via authToken
    return new AnthropicBedrock({
      awsRegion: effectiveRegion,
      skipAuth: true,
      authToken: bearerToken,
    } as ConstructorParameters<typeof AnthropicBedrock>[0]);
  } else {
    // Standard AWS credential chain (access key, profile, instance role, etc.)
    return new AnthropicBedrock({
      awsRegion: effectiveRegion,
    });
  }
}

async function getClient(region?: string): Promise<AnthropicBedrock> {
  if (!client) {
    client = await createClient(region);
  }
  return client;
}

export interface ModelResult {
  content: ContentBlock[];
  stopReason: string | null;
  usage?: UsageStats;
  aborted?: boolean;
}

/**
 * Send a message to Claude via Bedrock and return the full response.
 * Accepts system as plain string or structured TextBlockParam[] (for cache markers).
 */
export async function sendMessage(opts: {
  system: string | TextBlockParam[];
  messages: MessageParam[];
  tools?: Tool[];
  config?: ModelConfig;
  signal?: AbortSignal;
}): Promise<ModelResult> {
  const model = resolveBedrockModelId(opts.config?.model ?? DEFAULT_MODEL);
  const maxTokens = opts.config?.maxTokens ?? DEFAULT_MAX_TOKENS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const bedrock = await getClient(opts.config?.region);
    try {
      const response = await bedrock.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: opts.system,
          messages: opts.messages,
          tools: opts.tools,
        },
        opts.signal ? { signal: opts.signal } : undefined,
      );

      const usage: UsageStats | undefined = response.usage
        ? {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
            cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
          }
        : undefined;

      return {
        content: response.content,
        stopReason: response.stop_reason,
        usage,
      };
    } catch (err) {
      if (opts.signal?.aborted) {
        return { content: [], stopReason: null, aborted: true };
      }
      if (isAuthError(err) && attempt === 0) {
        // 403: credentials may have changed — re-read config and recreate client
        log.agent.warn('403 auth error, recreating client and retrying');
        client = null;
        continue;
      }
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt, err);
        console.error(`[model] 429/529 on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms...`);
        await sleep(delay, opts.signal);
        if (opts.signal?.aborted) return { content: [], stopReason: null, aborted: true };
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable: retry loop exhausted');
}

/**
 * Send a message to Claude via Bedrock using streaming.
 * Fires onTextDelta with each text chunk as it arrives.
 * Returns the same shape as sendMessage() once the stream completes.
 * When signal is aborted, the stream is cancelled and partial content is returned with aborted: true.
 */
export async function sendMessageStream(opts: {
  system: string | TextBlockParam[];
  messages: MessageParam[];
  tools?: Tool[];
  config?: ModelConfig;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}): Promise<ModelResult> {
  const model = resolveBedrockModelId(opts.config?.model ?? DEFAULT_MODEL);
  const maxTokens = opts.config?.maxTokens ?? DEFAULT_MAX_TOKENS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Accumulate text for partial response on abort (declared here for catch access)
    let accumulatedText = '';

    try {
      const bedrock = await getClient(opts.config?.region);
      const stream: MessageStream = bedrock.messages.stream({
        model,
        max_tokens: maxTokens,
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
      });

      // Wire abort signal to stream
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

      const usage: UsageStats | undefined = finalMsg.usage
        ? {
            input_tokens: finalMsg.usage.input_tokens,
            output_tokens: finalMsg.usage.output_tokens,
            cache_creation_input_tokens: (finalMsg.usage as unknown as Record<string, unknown>).cache_creation_input_tokens as number | undefined,
            cache_read_input_tokens: (finalMsg.usage as unknown as Record<string, unknown>).cache_read_input_tokens as number | undefined,
          }
        : undefined;

      return {
        content: finalMsg.content,
        stopReason: finalMsg.stop_reason,
        usage,
      };
    } catch (err) {
      if (opts.signal?.aborted) {
        // Return accumulated text as partial content
        const content: ContentBlock[] = accumulatedText
          ? [{ type: 'text', text: accumulatedText } as ContentBlock]
          : [];
        return { content, stopReason: null, aborted: true };
      }
      if (isAuthError(err) && attempt === 0) {
        // 403: credentials may have changed — re-read config and recreate client
        log.agent.warn('403 auth error on stream, recreating client and retrying');
        client = null;
        continue;
      }
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt, err);
        console.error(`[model] 429/529 on stream attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms...`);
        await sleep(delay, opts.signal);
        if (opts.signal?.aborted) return { content: [], stopReason: null, aborted: true };
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable: retry loop exhausted');
}

/**
 * Reset the client (useful for testing or config changes).
 */
export function resetClient(): void {
  client = null;
}
