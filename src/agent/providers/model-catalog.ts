/**
 * Hardcoded model catalog — the baseline of known models per provider.
 *
 * This is code-level data, NOT stored in config.yaml.
 * Users can override/extend via config.providers[name].models.
 * Merge: code catalog + user overrides (user wins for same ID, appended for new IDs).
 */
import type { ModelEntry } from './types.js';

/** Baseline model catalog. Provider name → known models.
 *  Only includes providers we actively test. Users can add more via config. */
export const MODEL_CATALOG: Record<string, ModelEntry[]> = {
  // ── AWS Bedrock (Claude via cross-region inference) ──
  // Models with 1M variants use model_id to map back to the same API model ID.
  // The API has no -1m model; 1M capability is activated via the context-1m beta header.
  // model_id therefore redirects the -1m catalog entry to the real API endpoint.
  bedrock: [
    { id: 'global.anthropic.claude-opus-4-8', provider: 'bedrock',
      label: 'Opus 4.8', max_tokens: 128_000, context_window: 200_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'global.anthropic.claude-opus-4-8-1m', provider: 'bedrock',
      model_id: 'global.anthropic.claude-opus-4-8',
      label: 'Opus 4.8 (1M)', max_tokens: 128_000, context_window: 1_000_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'global.anthropic.claude-opus-4-7', provider: 'bedrock',
      label: 'Opus 4.7', max_tokens: 128_000, context_window: 200_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'global.anthropic.claude-opus-4-7-1m', provider: 'bedrock',
      model_id: 'global.anthropic.claude-opus-4-7',
      label: 'Opus 4.7 (1M)', max_tokens: 128_000, context_window: 1_000_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'global.anthropic.claude-opus-4-6-v1', provider: 'bedrock',
      label: 'Opus 4.6', max_tokens: 128_000, context_window: 200_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'global.anthropic.claude-opus-4-6-v1-1m', provider: 'bedrock',
      model_id: 'global.anthropic.claude-opus-4-6-v1',
      label: 'Opus 4.6 (1M)', max_tokens: 128_000, context_window: 1_000_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'global.anthropic.claude-sonnet-4-6', provider: 'bedrock',
      label: 'Sonnet 4.6', max_tokens: 64_000, context_window: 200_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'global.anthropic.claude-sonnet-4-6-1m', provider: 'bedrock',
      model_id: 'global.anthropic.claude-sonnet-4-6',
      label: 'Sonnet 4.6 (1M)', max_tokens: 64_000, context_window: 1_000_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', provider: 'bedrock',
      label: 'Haiku 4.5', max_tokens: 64_000, context_window: 200_000 }, // No extended thinking — Haiku 4.5 doesn't support it
  ],
  // ── Anthropic Direct API ──
  anthropic: [
    { id: 'claude-opus-4-8', provider: 'anthropic',
      label: 'Opus 4.8', max_tokens: 128_000, context_window: 200_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'claude-opus-4-8-1m', provider: 'anthropic',
      model_id: 'claude-opus-4-8',
      label: 'Opus 4.8 (1M)', max_tokens: 128_000, context_window: 1_000_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'claude-opus-4-7', provider: 'anthropic',
      label: 'Opus 4.7', max_tokens: 128_000, context_window: 200_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'claude-opus-4-7-1m', provider: 'anthropic',
      model_id: 'claude-opus-4-7',
      label: 'Opus 4.7 (1M)', max_tokens: 128_000, context_window: 1_000_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'claude-opus-4-6', provider: 'anthropic',
      label: 'Opus 4.6', max_tokens: 128_000, context_window: 200_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'claude-opus-4-6-1m', provider: 'anthropic',
      model_id: 'claude-opus-4-6',
      label: 'Opus 4.6 (1M)', max_tokens: 128_000, context_window: 1_000_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'claude-sonnet-4-6', provider: 'anthropic',
      label: 'Sonnet 4.6', max_tokens: 64_000, context_window: 200_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'claude-sonnet-4-6-1m', provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
      label: 'Sonnet 4.6 (1M)', max_tokens: 64_000, context_window: 1_000_000,
      compat: { thinking_format: 'anthropic', supports_adaptive: true } },
    { id: 'claude-haiku-4-5', provider: 'anthropic',
      label: 'Haiku 4.5', max_tokens: 64_000, context_window: 200_000 }, // No extended thinking — Haiku 4.5 doesn't support it
  ],
  // ── OpenAI ──
  openai: [
    { id: 'gpt-5.4', provider: 'openai',
      label: 'GPT-5.4', max_tokens: 128_000, context_window: 1_050_000 },
    { id: 'gpt-5-mini-2025-08-07', provider: 'openai',
      label: 'GPT-5 Mini', max_tokens: 128_000, context_window: 400_000 },
    { id: 'gpt-5-nano-2025-08-07', provider: 'openai',
      label: 'GPT-5 Nano', max_tokens: 128_000, context_window: 400_000 },
  ],
  // ── Google Gemini ──
  gemini: [
    { id: 'gemini-3.1-pro-preview', provider: 'gemini',
      label: 'Gemini 3.1 Pro', max_tokens: 65_536, context_window: 1_000_000 },
    { id: 'gemini-3-flash-preview', provider: 'gemini',
      label: 'Gemini 3 Flash', max_tokens: 65_536, context_window: 1_000_000 },
    { id: 'gemini-3.1-flash-lite-preview', provider: 'gemini',
      label: 'Gemini 3.1 Flash Lite', max_tokens: 65_536, context_window: 1_000_000 },
  ],
  // ── OpenRouter (aggregator — sorted by release date, newest first) ──
  openrouter: [
    // -- Anthropic --
    { id: 'anthropic/claude-opus-4.6', provider: 'openrouter',
      label: 'Claude Opus 4.6', max_tokens: 128_000, context_window: 1_000_000 },
    { id: 'anthropic/claude-sonnet-4.6', provider: 'openrouter',
      label: 'Claude Sonnet 4.6', max_tokens: 64_000, context_window: 1_000_000 },
    // -- OpenAI --
    { id: 'openai/gpt-5.2', provider: 'openrouter',
      label: 'GPT-5.2', max_tokens: 128_000, context_window: 400_000 },
    { id: 'openai/gpt-5.2-pro', provider: 'openrouter',
      label: 'GPT-5.2 Pro', max_tokens: 128_000, context_window: 400_000 },
    { id: 'openai/gpt-5.2-chat', provider: 'openrouter',
      label: 'GPT-5.2 Chat', max_tokens: 128_000, context_window: 128_000 },
    // -- Google --
    { id: 'google/gemini-3.1-pro-preview', provider: 'openrouter',
      label: 'Gemini 3.1 Pro', max_tokens: 65_536, context_window: 1_048_576 },
    { id: 'google/gemini-3-flash-preview', provider: 'openrouter',
      label: 'Gemini 3 Flash', max_tokens: 65_536, context_window: 1_048_576 },
    // -- Qwen --
    { id: 'qwen/qwen3.5-plus-02-15', provider: 'openrouter',
      label: 'Qwen 3.5 Plus', max_tokens: 128_000, context_window: 1_000_000 },
    { id: 'qwen/qwen3.5-397b-a17b', provider: 'openrouter',
      label: 'Qwen 3.5 397B', max_tokens: 128_000, context_window: 262_144 },
    { id: 'qwen/qwen3-max-thinking', provider: 'openrouter',
      label: 'Qwen3 Max Thinking', max_tokens: 128_000, context_window: 262_144 },
    { id: 'qwen/qwen3-coder-next', provider: 'openrouter',
      label: 'Qwen3 Coder Next', max_tokens: 128_000, context_window: 262_144 },
    // -- MiniMax --
    { id: 'minimax/minimax-m2.5', provider: 'openrouter',
      label: 'MiniMax M2.5', max_tokens: 128_000, context_window: 196_608 },
    { id: 'minimax/minimax-m2.1', provider: 'openrouter',
      label: 'MiniMax M2.1', max_tokens: 128_000, context_window: 196_608 },
    { id: 'minimax/minimax-m2-her', provider: 'openrouter',
      label: 'MiniMax M2 Her', max_tokens: 128_000, context_window: 65_536 },
    // -- Z.ai (GLM) --
    { id: 'z-ai/glm-5', provider: 'openrouter',
      label: 'GLM 5', max_tokens: 128_000, context_window: 202_752 },
    { id: 'z-ai/glm-4.7', provider: 'openrouter',
      label: 'GLM 4.7', max_tokens: 128_000, context_window: 202_752 },
    { id: 'z-ai/glm-4.7-flash', provider: 'openrouter',
      label: 'GLM 4.7 Flash', max_tokens: 128_000, context_window: 202_752 },
    // -- Moonshot / Kimi --
    { id: 'moonshotai/kimi-k2.5', provider: 'openrouter',
      label: 'Kimi K2.5', max_tokens: 128_000, context_window: 262_144 },
    // -- AionLabs --
    { id: 'aion-labs/aion-2.0', provider: 'openrouter',
      label: 'Aion 2.0', max_tokens: 128_000, context_window: 131_072 },
    // -- StepFun --
    { id: 'stepfun/step-3.5-flash', provider: 'openrouter',
      label: 'Step 3.5 Flash', max_tokens: 128_000, context_window: 256_000 },
    { id: 'stepfun/step-3.5-flash:free', provider: 'openrouter',
      label: 'Step 3.5 Flash (free)', max_tokens: 128_000, context_window: 256_000 },
    // -- ByteDance Seed --
    { id: 'bytedance-seed/seed-1.6', provider: 'openrouter',
      label: 'Seed 1.6', max_tokens: 128_000, context_window: 262_144 },
    { id: 'bytedance-seed/seed-1.6-flash', provider: 'openrouter',
      label: 'Seed 1.6 Flash', max_tokens: 128_000, context_window: 262_144 },
    // -- Xiaomi --
    { id: 'xiaomi/mimo-v2-flash', provider: 'openrouter',
      label: 'MiMo V2 Flash', max_tokens: 128_000, context_window: 262_144 },
    // -- NVIDIA --
    { id: 'nvidia/nemotron-3-nano-30b-a3b', provider: 'openrouter',
      label: 'Nemotron 3 Nano 30B', max_tokens: 128_000, context_window: 262_144 },
    { id: 'nvidia/nemotron-3-nano-30b-a3b:free', provider: 'openrouter',
      label: 'Nemotron 3 Nano 30B (free)', max_tokens: 128_000, context_window: 256_000 },
    // -- Writer --
    { id: 'writer/palmyra-x5', provider: 'openrouter',
      label: 'Palmyra X5', max_tokens: 128_000, context_window: 1_040_000 },
    // -- Upstage --
    { id: 'upstage/solar-pro-3', provider: 'openrouter',
      label: 'Solar Pro 3', max_tokens: 128_000, context_window: 128_000 },
    // -- Mistral --
    { id: 'mistralai/mistral-small-creative', provider: 'openrouter',
      label: 'Mistral Small Creative', max_tokens: 128_000, context_window: 32_768 },
    // -- AllenAI --
    { id: 'allenai/olmo-3.1-32b-instruct', provider: 'openrouter',
      label: 'OLMo 3.1 32B Instruct', max_tokens: 128_000, context_window: 65_536 },
    { id: 'allenai/olmo-3.1-32b-think', provider: 'openrouter',
      label: 'OLMo 3.1 32B Think', max_tokens: 128_000, context_window: 65_536 },
    { id: 'allenai/molmo-2-8b', provider: 'openrouter',
      label: 'Molmo2 8B', max_tokens: 128_000, context_window: 36_864 },
    // -- Arcee --
    { id: 'arcee-ai/trinity-large-preview:free', provider: 'openrouter',
      label: 'Trinity Large Preview (free)', max_tokens: 128_000, context_window: 131_000 },
  ],
  // ── Ollama (local) — empty baseline, user adds their installed models ──
  ollama: [],
};

/**
 * Get models for a provider: code catalog merged with user config override.
 * User overrides win for matching IDs; new IDs are appended.
 */
export function getModelsForProvider(
  providerName: string,
  configOverrides?: ModelEntry[],
): ModelEntry[] {
  const catalog = MODEL_CATALOG[providerName] ?? [];
  if (!configOverrides?.length) return [...catalog];

  const merged = [...catalog];
  for (const override of configOverrides) {
    const idx = merged.findIndex(m => m.id === override.id);
    if (idx >= 0) {
      // User override replaces catalog entry (spread keeps catalog defaults for missing fields)
      merged[idx] = { ...merged[idx], ...override };
    } else {
      // New model from user — append with provider defaulted to this provider
      // (override.provider wins if the user set one explicitly).
      merged.push({ ...override, provider: override.provider ?? providerName });
    }
  }
  return merged;
}

