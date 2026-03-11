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
  anthropic: { api: 'anthropic-messages' },
  bedrock: { api: 'bedrock' },
  openai: { api: 'openai-chat' },
  openrouter: { api: 'openai-chat', base_url: 'https://openrouter.ai/api/v1' },
  together: { api: 'openai-chat', base_url: 'https://api.together.xyz/v1' },
  deepseek: { api: 'openai-chat', base_url: 'https://api.deepseek.com/v1' },
  moonshot: { api: 'openai-chat', base_url: 'https://api.moonshot.cn/v1' },
  qwen: { api: 'openai-chat', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  doubao: { api: 'openai-chat', base_url: 'https://ark.cn-beijing.volces.com/api/v3' },
  nvidia: { api: 'openai-chat', base_url: 'https://integrate.api.nvidia.com/v1' },
  gemini: { api: 'google-generative-ai' },
  ollama: { api: 'ollama' },
};

/** Default model constant — backward compat. */
export const DEFAULT_MODEL = 'global.anthropic.claude-opus-4-6-v1';
export const DEFAULT_MAX_TOKENS = 32768;

/** Context window sizes. */
export const CONTEXT_WINDOW_1M = 1_000_000;
export const CONTEXT_WINDOW_DEFAULT = 200_000;

/** Beta header for 1M context window. */
export const BETA_CONTEXT_1M = 'context-1m-2025-08-07';

/** Strip [1m] suffix used as context-window marker — API model IDs don't include it. */
export function stripModelSuffix(model: string): string {
  return model.replace(/\[1m\]$/, '');
}
