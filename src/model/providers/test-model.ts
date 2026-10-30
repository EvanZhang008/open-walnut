/**
 * Which model Settings' "Test connection" (POST /api/config/test-provider) sends
 * its one-token call to.
 *
 * A cloud provider has a catalog, so a fixed cheap model proves the key works. A
 * model server the user hosts (Ollama, LM Studio, vLLM) has no catalog: its models
 * are whatever the user pulled. For those the test uses the model Walnut is set to
 * call there (`agent.main_model` when it is the main provider), checks the server
 * holds it, and falls back to the first model the server lists. A provider whose
 * protocol has no fixed test model (a plugin's adapter) is tested the same way with
 * its configured models. Before 2026-10-30 every protocol outside the table answered
 * "Testing not yet supported", Ollama included, which the setup guide tells a local
 * model user to test with.
 */
import type { ApiProtocol, ProviderConfig } from './types.js';
import { MODEL_CATALOG } from './model-catalog.js';
import { DEFAULT_MODEL } from './defaults.js';
import {
  isLocalModelProvider,
  listLocalModelIds,
  localProviderBaseUrl,
  probeLocalProvider,
} from './local-provider.js';

/** A cheap model per protocol (and per provider where one protocol serves several). */
export const CLOUD_TEST_MODELS: Partial<Record<ApiProtocol, Record<string, string>>> = {
  'bedrock': { '*': 'global.anthropic.claude-haiku-5-5' },
  'anthropic-messages': { '*': 'claude-haiku-5-5' },
  'openai-chat': {
    'openai': 'gpt-4o-mini',
    'openrouter': 'nvidia/nemotron-3-nano-30b-a3b:free', // Uses :free model to test connectivity without requiring paid credits
    'deepseek': 'deepseek-chat',
    '*': 'gpt-4o-mini',
  },
  'google-generative-ai': { '*': 'gemini-3-flash-preview' },
  // claude-cli spawns the local `claude -p`; a short alias resolves to the
  // subscription's model. maxTokens is ignored by the CLI (it runs its own turn).
  'claude-cli': { '*': 'haiku' },
};

export type TestModelPick = { ok: true; model: string } | { ok: false; error: string };

export interface PickTestModelInput {
  providerName: string;
  prov: ProviderConfig;
  /** The `agent` section: which provider and models Walnut's own calls use. */
  agent?: { main_provider?: string; main_model?: string; fast_model?: string };
  /** A model the caller asked to test explicitly. */
  requested?: string;
}

/** Ollama treats a name without a tag as `:latest`. */
function sameLocalModel(api: ApiProtocol, a: string, b: string): boolean {
  if (a === b) return true;
  if (api !== 'ollama') return false;
  // Ollama names are case-insensitive, and a name without a tag means :latest.
  const norm = (s: string) => (s.includes(':') ? s : `${s}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

/**
 * A Claude catalog id. getConfig fills an unset `agent.main_model` with one in
 * memory, so on a local server it means "no model set here", never a model to pull.
 */
function isClaudeCatalogId(id: string): boolean {
  if (id === DEFAULT_MODEL) return true;
  return ['bedrock', 'anthropic', 'claude_cli'].some((p) => (MODEL_CATALOG[p] ?? []).some((m) => m.id === id));
}

/** What the server is called in a sentence. */
function serverName(providerName: string, prov: ProviderConfig): string {
  return prov.api === 'ollama' ? 'Ollama' : providerName;
}

/** The model Walnut is configured to call on this provider, if any. */
function configuredModel(input: PickTestModelInput): string | undefined {
  const { agent, providerName, prov } = input;
  if (agent?.main_provider === providerName) {
    const m = agent.main_model?.trim() || agent.fast_model?.trim();
    if (m) return m;
  }
  return prov.models?.[0]?.id;
}

export async function pickTestModel(input: PickTestModelInput): Promise<TestModelPick> {
  const { providerName, prov } = input;
  const requested = input.requested?.trim();

  if (isLocalModelProvider(prov)) {
    const name = serverName(providerName, prov);
    const base = localProviderBaseUrl(prov);
    const probe = await probeLocalProvider(prov);
    if (!probe.ok) {
      const start = prov.api === 'ollama' ? ' Start it (`ollama serve`, or open the Ollama app) and test again.' : ' Start it and test again.';
      return { ok: false, error: `${name} is not answering at ${base}.${start}` };
    }
    const installed = await listLocalModelIds(prov);
    const configured = configuredModel(input);
    if (!requested && configured && isClaudeCatalogId(configured)) {
      const has = installed && installed.length > 0 ? ` It has: ${installed.slice(0, 8).join(', ')}.` : '';
      return { ok: false, error: `agent.main_model is ${configured}, a Claude model. Set it to a model ${name} serves.${has}` };
    }
    const wanted = requested || configured;
    if (wanted) {
      // Only a list the server actually returned can prove a model missing.
      if (installed && installed.length > 0 && !installed.some((m) => sameLocalModel(prov.api, m, wanted))) {
        const pull = prov.api === 'ollama' ? ` Pull it with \`ollama pull ${wanted}\`, or pick one it has:` : ' It has:';
        return { ok: false, error: `${name} at ${base} has no model "${wanted}".${pull} ${installed.slice(0, 8).join(', ')}.` };
      }
      return { ok: true, model: wanted };
    }
    if (installed && installed.length > 0) return { ok: true, model: installed[0] };
    const pull = prov.api === 'ollama' ? ' Pull one with `ollama pull qwen3-coder:30b`.' : ' Load a model in it first.';
    return { ok: false, error: `${name} answers at ${base} but lists no models.${pull}` };
  }

  if (requested) return { ok: true, model: requested };
  const table = CLOUD_TEST_MODELS[prov.api];
  if (table?.[providerName]) return { ok: true, model: table[providerName] };
  const configured = configuredModel(input);
  // An OpenAI-compatible service with no entry of its own (Together, Groq, a
  // gateway) serves its own models, so the one it is set to is the honest test.
  if (configured && (prov.api === 'openai-chat' || !table)) return { ok: true, model: configured };
  if (table?.['*']) return { ok: true, model: table['*'] };
  return { ok: false, error: `No model to test "${providerName}" with: set agent.main_model, or list one under providers.${providerName}.models.` };
}
