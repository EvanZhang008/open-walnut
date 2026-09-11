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

/** Builtin protocols have native adapters; full-trust Plugins may add more. */
export type BuiltinApiProtocol =
  | 'anthropic-messages'      // Anthropic, MiniMax, Xiaomi, Cloudflare
  | 'openai-chat'             // OpenAI, OpenRouter, Together, DeepSeek, Moonshot, Qwen, ...
  | 'bedrock'                 // AWS Bedrock
  | 'google-generative-ai'    // Google Gemini
  | 'ollama'                  // Local Ollama
  | 'claude-cli';             // Local `claude -p` subprocess (subscription, text-only)

export type ApiProtocol = BuiltinApiProtocol | (string & {});

// ── Per-model quirks ──

/** Avoids hardcoding provider-specific behavior. Lives on the model entry. */
export interface ModelCompat {
  thinking_format?: 'anthropic' | 'openai' | 'deepseek' | 'qwen';
  /** True for models that support adaptive thinking (Opus 4.6, Sonnet 4.6). */
  supports_adaptive?: boolean;
  /** True for models whose context window is natively 1M with no beta header
   *  (e.g. Opus 5 — 1M is the default AND the only size). Suppresses the
   *  context-1m beta push that context_window >= 1M would otherwise trigger. */
  native_1m?: boolean;
  max_tokens_field?: 'max_tokens' | 'max_completion_tokens';
  supports_cache?: boolean;
  supports_vision?: boolean;
  supports_tool_use?: boolean;
  requires_tool_result_name?: boolean;
  requires_assistant_after_tool_result?: boolean;
}

// ── Thinking configuration ──

/** Thinking config passed to Claude API. */
export type ThinkingConfig =
  // display: newer models (Opus 4.7/4.8+) default to 'omitted' — thinking blocks
  // come back with empty text + encrypted signature only. Explicitly requesting
  // 'summarized' restores visible thinking summaries (verified live on Bedrock;
  // full thinking is billed either way, so this costs nothing extra).
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' };

// ── Provider configuration ──

/** Provider configuration from config.yaml `providers` section. */
export interface ProviderConfig {
  api: ApiProtocol;
  api_key?: string;            // Resolved (env vars expanded)
  base_url?: string;           // Protocol-specific default if omitted
  region?: string;             // Bedrock-specific
  bearer_token?: string;       // Bedrock: Identity Center bearer token
  aws_access_key_id?: string;  // Bedrock: explicit IAM access key
  aws_secret_access_key?: string; // Bedrock: explicit IAM secret key
  aws_session_token?: string;  // Bedrock: STS session token (temporary creds)
  aws_profile?: string;        // Bedrock: AWS profile from ~/.aws/config
  /** Bedrock: a shell command that prints AWS creds as JSON `{Credentials:{...}}`
   *  (Claude Code's `awsCredentialExport` settings key — `aws configure
   *  export-credentials --format process` shape). The adapter runs it, caches
   *  the temporary creds, and re-runs on expiry. */
  aws_credential_export?: string;
  auth_header?: boolean;       // Use Authorization header instead of x-api-key
  headers?: Record<string, string>;  // Extra headers (e.g., OpenRouter site headers)
  /** claude-cli: override the `claude` binary path (defaults to PATH lookup).
   *  Used when a specific install must win (e.g. the logged-in toolbox binary). */
  claude_cli_command?: string;
  /** User-defined model overrides. Merged with code-level MODEL_CATALOG at runtime.
   *  Matching IDs override catalog entries; new IDs are appended. */
  models?: ModelEntry[];
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
  /** Beta feature flags (e.g., 'context-1m-2025-08-07' for 1M context window). */
  betas?: string[];
  /** Thinking configuration for Claude models. */
  thinking?: ThinkingConfig;
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
