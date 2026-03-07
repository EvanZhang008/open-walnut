/**
 * Shared retry infrastructure for protocol adapters.
 *
 * Aggressive retry on 429 (rate limit) and 529/503 (overloaded/unavailable).
 * Exponential backoff with jitter. Respects retry-after headers.
 */
import { RateLimitError, APIError } from '@anthropic-ai/sdk';
import type { ContentBlock, UsageStats } from './types.js';

// Retry config
export const MAX_RETRIES = 10;
export const BASE_DELAY_MS = 1000;
export const MAX_DELAY_MS = 60000;
export const JITTER_FACTOR = 0.3;

export function isRetryableError(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof APIError && (err.status === 529 || err.status === 503)) return true;
  return false;
}

export function isAuthError(err: unknown): boolean {
  return err instanceof APIError && err.status === 403;
}

export function getRetryDelay(attempt: number, err: unknown): number {
  if (err instanceof APIError && err.headers) {
    const retryAfter = err.headers['retry-after'];
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  const exponential = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  const jitter = exponential * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(500, exponential + jitter);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Build an aborted ModelResult with optional accumulated text. */
export function abortedResult(accumulatedText?: string): { content: ContentBlock[]; stopReason: null; aborted: true } {
  const content: ContentBlock[] = accumulatedText
    ? [{ type: 'text', text: accumulatedText } as ContentBlock]
    : [];
  return { content, stopReason: null, aborted: true };
}

/** Extract UsageStats from an API response's usage object. Accepts any shape. */
export function extractUsage(usage: unknown): UsageStats | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  return {
    input_tokens: typeof u.input_tokens === 'number' ? u.input_tokens : undefined,
    output_tokens: typeof u.output_tokens === 'number' ? u.output_tokens : undefined,
    cache_creation_input_tokens: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : undefined,
    cache_read_input_tokens: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : undefined,
  };
}
