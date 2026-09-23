/**
 * Which engine answers Walnut's own background calls (`agent.main_provider`).
 *
 * The name alone is not the answer: a user-named entry under `providers` (for
 * example `work-cli` with `api: claude-cli`) runs on whatever its `api` says,
 * exactly as the server's `resolveProvider` reads it. Every pane that names the
 * background engine (Tasks, Engines, Advanced) resolves through here so a
 * Claude CLI entry never reads as "an unknown API" (N01).
 */

type ProviderEntry = { api?: string; base_url?: string } | undefined;

/** Built-in provider ids and the protocol each one speaks. */
const BUILTIN_API: Record<string, string> = {
  claude_cli: 'claude-cli',
  bedrock: 'bedrock',
  anthropic: 'anthropic-messages',
  openai: 'openai-chat',
  openrouter: 'openai-chat',
  gemini: 'google-generative-ai',
  ollama: 'ollama',
};

/** Display names for the built-in ids. */
export const API_LABELS: Record<string, string> = {
  claude_cli: 'Claude Code',
  bedrock: 'AWS Bedrock',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  ollama: 'Ollama',
};

/** Protocol to the built-in id whose label and setup rows fit it. */
const BUILTIN_FOR_API: Record<string, string> = {
  'claude-cli': 'claude_cli',
  bedrock: 'bedrock',
  'anthropic-messages': 'anthropic',
  'openai-chat': 'openai',
  'google-generative-ai': 'gemini',
  ollama: 'ollama',
};

export interface MainProviderInfo {
  /** The raw `agent.main_provider` (or the server default). */
  name: string | undefined;
  /** `cli` = Claude Code; `api` = a known API; `unknown` = a protocol this build lacks. */
  kind: 'cli' | 'api' | 'unknown';
  /** Built-in id whose label fits (the name itself, or the one matching the entry's api). */
  builtin: string | undefined;
  /** True when the name is a user-named entry rather than a built-in id. */
  custom: boolean;
  /** What the UI calls it. */
  label: string;
}

export function resolveMainProvider(
  name: string | undefined,
  providers?: Record<string, ProviderEntry>,
): MainProviderInfo {
  if (!name) return { name, kind: 'cli', builtin: 'claude_cli', custom: false, label: 'Claude Code' };
  const entry = providers?.[name];
  const custom = !(name in BUILTIN_API);
  const api = entry?.api ?? BUILTIN_API[name];
  let builtin = custom ? (api ? BUILTIN_FOR_API[api] : undefined) : name;
  if (custom && api === 'openai-chat' && /openrouter\.ai/.test(entry?.base_url ?? '')) builtin = 'openrouter';
  if (api === 'claude-cli') return { name, kind: 'cli', builtin: 'claude_cli', custom, label: 'Claude Code' };
  if (!builtin) return { name, kind: 'unknown', builtin: undefined, custom, label: 'Your API' };
  return { name, kind: 'api', builtin, custom, label: API_LABELS[builtin] ?? 'Your API' };
}
