/**
 * Default values for providers and protocols.
 */
import type { ApiProtocol, ProviderConfig } from './types.js';

/** Default base URLs per protocol. */
export const DEFAULT_BASE_URLS: Partial<Record<ApiProtocol, string>> = {
  'anthropic-messages': 'https://api.anthropic.com',
  'openai-chat': 'https://api.openai.com/v1',
  'ollama': 'http://localhost:11434',
  'google-generative-ai': 'https://generativelanguage.googleapis.com',
  // bedrock uses SDK, no base_url
};

/** Known provider templates — used for auto-discovery from env vars. */
export const KNOWN_PROVIDERS: Record<string, Omit<ProviderConfig, 'api_key'>> = {
  bedrock: { api: 'bedrock' },
  anthropic: { api: 'anthropic-messages' },
  openai: { api: 'openai-chat' },
  openrouter: { api: 'openai-chat', base_url: 'https://openrouter.ai/api/v1' },
  gemini: { api: 'google-generative-ai' },
  ollama: { api: 'ollama' },
  // Local Claude Code subscription, text-only. Keyless — readiness is probed via
  // detectClaudeCli() (binary on PATH + subscription credential exists).
  claude_cli: { api: 'claude-cli' },
};

/** Default model constant — backward compat. */
export const DEFAULT_MODEL = 'global.anthropic.claude-opus-5';
/**
 * Conservative default — works with every known model.
 * Users wanting more output (e.g. Opus 4 supports 32768) set agent.maxTokens in config.
 */
export const DEFAULT_MAX_TOKENS = 4096;

/** Context window sizes. */
export const CONTEXT_WINDOW_1M = 1_000_000;
export const CONTEXT_WINDOW_DEFAULT = 200_000;

/** Beta header for 1M context window. */
export const BETA_CONTEXT_1M = 'context-1m-2025-08-07';

/** Beta header for interleaved thinking (thinking blocks between tool calls). */
export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

/**
 * Beta flag string for the 1-hour extended prompt-cache TTL (`cache_control.ttl: '1h'`).
 *
 * IMPORTANT — do NOT send this to Bedrock. The 1h cache duration is GA on both the
 * Claude API and Amazon Bedrock and needs no beta header; the `ttl:'1h'` marker flows
 * through `cache_control` directly. We verified empirically (skill-e2e against real
 * Bedrock) that adding this flag makes every request fail with `400 invalid beta flag`.
 *
 * Kept only as documentation of the flag name and this finding — it is intentionally
 * NOT pushed into the betas array (see model.ts resolveForCall).
 */
export const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11';

/**
 * Sanitize a model string from Claude CLI's system init event.
 *
 * Claude CLI may embed ANSI escape codes (e.g. `\x1b[1m` for bold) in the
 * model field when `--verbose` is used.  We strip those, but ONLY real ANSI
 * sequences (prefixed with `\x1b`).  A bare `[1m]` suffix is the CLI's own
 * display/resume marker for 1M context sessions and must be preserved.
 * (Context window detection is now catalog-driven; this suffix is NOT used for
 * API context decisions.)
 *
 * After stripping, validates the result against known model-string patterns.
 * Returns `undefined` if the result looks malformed (orphan brackets, control
 * chars, etc.) — callers should fall back to the raw assistant-message model.
 */
export function sanitizeInitModel(raw: string): string | undefined {
  // Step 1: Strip real ANSI escape sequences (ESC + [ + params + letter)
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

  // Step 2: Validate — a sane model string should:
  //   - contain only alphanumeric, dots, dashes, underscores, and optionally [1m] suffix
  //   - NOT have orphan brackets like "v1]" or stray control characters
  if (/[^\w.\-\[\]]/.test(cleaned)) return undefined;        // unexpected chars
  if (/\](?!\s*$)/.test(cleaned) && !cleaned.includes('[')) return undefined;  // ] without [
  if (cleaned.endsWith(']') && !cleaned.endsWith('[1m]')) return undefined;    // orphan ]
  if (cleaned.includes('[') && !cleaned.includes('[1m]')) return undefined;    // unknown [...] suffix

  // De-duplicate [1m][1m] → [1m] (caused by old resume bug passing full model string
  // as --model arg; CLI appended another [1m] marker)
  const deduped = cleaned.replace(/(\[1m\])+$/, '[1m]');

  return deduped || undefined;
}

