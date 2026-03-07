/**
 * Multi-provider type definitions.
 *
 * Core abstraction: providers are configuration, protocols are code.
 * 5 protocol adapters serve unlimited providers — adding a new provider
 * that speaks an existing protocol requires zero code changes, just config.
 */
import type { ContentBlock, MessageParam, Tool, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';

// Re-export Anthropic types used across the system
export type { ContentBlock, MessageParam, Tool, TextBlockParam };

// ── Protocol identifiers ──

/** Each protocol maps to exactly one adapter implementation. */
export type ApiProtocol =
  | 'anthropic-messages'      // Anthropic, MiniMax, Xiaomi, Cloudflare
  | 'openai-chat'             // OpenAI, OpenRouter, Together, DeepSeek, Moonshot, Qwen, ...
  | 'bedrock'                 // AWS Bedrock
  | 'google-generative-ai'    // Google Gemini
  | 'ollama';                 // Local Ollama

// ── Per-model quirks ──

/** Avoids hardcoding provider-specific behavior. Lives on the model entry. */
export interface ModelCompat {
  thinking_format?: 'anthropic' | 'openai' | 'deepseek' | 'qwen';
  max_tokens_field?: 'max_tokens' | 'max_completion_tokens';
  supports_cache?: boolean;
  supports_vision?: boolean;
  supports_tool_use?: boolean;
  requires_tool_result_name?: boolean;
  requires_assistant_after_tool_result?: boolean;
}

// ── Provider configuration ──

/** Provider configuration from config.yaml `providers` section. */
export interface ProviderConfig {
  api: ApiProtocol;
  api_key?: string;            // Resolved (env vars expanded)
  base_url?: string;           // Protocol-specific default if omitted
  region?: string;             // Bedrock-specific
  bearer_token?: string;       // Bedrock-specific
  auth_header?: boolean;       // Use Authorization header instead of x-api-key
  headers?: Record<string, string>;  // Extra headers (e.g., OpenRouter site headers)
}

// ── Model catalog ──

/** Model entry in available_models catalog. */
export interface ModelEntry {
  id: string;                  // User-facing ID (unique key)
  provider: string;            // Provider ID key from providers section
  model_id?: string;           // Protocol-specific model ID (sent to API)
  label?: string;              // Display name in UI
  context_window?: number;     // Token limit
  max_tokens?: number;         // Max output tokens
  compat?: ModelCompat;        // Per-model quirks
  cost?: {                     // Per-token pricing ($/MTok)
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
}

// ── Usage stats ──

export interface UsageStats {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Model ID used for this API call (populated by the agent loop). */
  model?: string;
}

// ── Model result ──

export interface ModelResult {
  content: ContentBlock[];
  stopReason: string | null;
  usage?: UsageStats;
  aborted?: boolean;
}

// ── Adapter interface ──

/** Options passed to adapter — protocol-agnostic. */
export interface AdapterCallOptions {
  providerConfig: ProviderConfig;   // Resolved provider config
  model: string;                    // Protocol-specific model ID
  maxTokens: number;
  system: string | TextBlockParam[];
  messages: MessageParam[];
  tools?: Tool[];
  signal?: AbortSignal;
  compat?: ModelCompat;             // Per-model quirks
}

/** The adapter interface — one implementation per protocol. */
export interface ProtocolAdapter {
  readonly protocol: ApiProtocol;

  /** Non-streaming send — returns Anthropic-normalized response. */
  sendMessage(opts: AdapterCallOptions): Promise<ModelResult>;

  /** Streaming send — fires onTextDelta for each chunk. */
  sendMessageStream(
    opts: AdapterCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<ModelResult>;

  /** Reset cached client (credential refresh). */
  resetClient(): void;
}
