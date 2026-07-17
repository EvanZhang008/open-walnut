/**
 * Provider Registry — resolves provider config to protocol adapter.
 *
 * The registry is the single mapping from provider names (config) to adapter
 * instances (code). It:
 *   1. Reads providers from config.yaml
 *   2. Auto-discovers providers from environment variables
 *   3. Merges explicit config over auto-detected (explicit wins)
 *   4. Caches adapter instances per protocol (adapters are stateless)
 *   5. Resolves secrets before passing config to adapters
 */
import type { ApiProtocol, ProtocolAdapter, ProviderConfig } from './types.js';
import type { Config } from '../../core/types.js';
import { resolveCredentials } from '../../core/credential-resolver.js';
import { resolveProviderSecrets, autoDetectApiKey } from './secret.js';
import { KNOWN_PROVIDERS } from './defaults.js';
import { BedrockAdapter } from './adapter-bedrock.js';
import { AnthropicAdapter } from './adapter-anthropic.js';
import { OpenAIAdapter } from './adapter-openai.js';
import { GoogleAdapter } from './adapter-google.js';
import { OllamaAdapter } from './adapter-ollama.js';
import { ClaudeCliAdapter } from './adapter-claude-cli.js';
import { log } from '../../logging/index.js';

// ── Adapter factory ──

const adapterCache = new Map<ApiProtocol, ProtocolAdapter>();

function getOrCreateAdapter(protocol: ApiProtocol): ProtocolAdapter {
  let adapter = adapterCache.get(protocol);
  if (adapter) return adapter;

  switch (protocol) {
    case 'bedrock':
      adapter = new BedrockAdapter();
      break;
    case 'anthropic-messages':
      adapter = new AnthropicAdapter();
      break;
    case 'openai-chat':
      adapter = new OpenAIAdapter();
      break;
    case 'google-generative-ai':
      adapter = new GoogleAdapter();
      break;
    case 'ollama':
      adapter = new OllamaAdapter();
      break;
    case 'claude-cli':
      adapter = new ClaudeCliAdapter();
      break;
    default:
      throw new Error(`Unknown protocol: ${protocol}`);
  }

  adapterCache.set(protocol, adapter);
  return adapter;
}

// ── Provider resolution ──

export interface ResolvedProvider {
  config: ProviderConfig;
  adapter: ProtocolAdapter;
}

/**
 * Resolve a provider by name from the config's providers section.
 * Returns the resolved config (secrets expanded) + the protocol adapter.
 */
export function resolveProvider(
  providerName: string,
  providers: Record<string, ProviderConfig>,
): ResolvedProvider {
  const rawConfig = providers[providerName];
  if (!rawConfig) {
    throw new Error(`Provider "${providerName}" not found in config. Available: ${Object.keys(providers).join(', ')}`);
  }

  const config = resolveProviderSecrets(rawConfig, providerName);
  const adapter = getOrCreateAdapter(config.api);
  return { config, adapter };
}

/**
 * Build the merged providers map: explicit config + auto-detected from env.
 * Explicit config always wins over auto-detected.
 *
 * `fullConfig` (optional) lets Bedrock auth be filled from the unified credential
 * resolver — which adds ~/.claude/settings.json's env block as a source on top of
 * env + ~/.aws. Callers that only have the providers slice can omit it; they then
 * get the original env-token-only behavior for backward compatibility.
 */
export function buildProviderMap(
  explicitProviders?: Record<string, ProviderConfig>,
  fullConfig?: Config,
): Record<string, ProviderConfig> {
  const result: Record<string, ProviderConfig> = {};

  // 1. Auto-detect from environment
  for (const [name, template] of Object.entries(KNOWN_PROVIDERS)) {
    const apiKey = autoDetectApiKey(name);
    if (apiKey || name === 'bedrock' || name === 'ollama') {
      result[name] = { ...template, ...(apiKey ? { api_key: apiKey } : {}) };
    }
  }

  // 2. Overlay explicit config (wins over auto-detected)
  if (explicitProviders) {
    for (const [name, config] of Object.entries(explicitProviders)) {
      result[name] = config;
    }
  }

  // 3. Fill Bedrock auth when none is explicitly configured, using the unified
  //    resolver (settings.json env → process.env → ~/.aws). Only fill when there's
  //    no bearer_token / access keys / profile so the user's chosen auth wins.
  if (result.bedrock && !result.bedrock.bearer_token
      && !result.bedrock.aws_access_key_id && !result.bedrock.aws_profile) {
    result.bedrock = applyResolvedBedrockAuth(result.bedrock, fullConfig);
  }

  return result;
}

/**
 * Fill a Bedrock ProviderConfig's auth fields from the unified credential resolver.
 * `aws_chain` / `none` add no explicit fields — the SDK's default credential chain
 * handles them. Region is filled only when not already set on the provider config.
 */
function applyResolvedBedrockAuth(bedrock: ProviderConfig, fullConfig?: Config): ProviderConfig {
  const cfg = fullConfig ?? ({ version: 1, user: {}, defaults: { priority: 'none', category: 'personal' }, provider: { type: 'claude-code' } } as Config);
  const resolved = resolveCredentials(cfg);
  const out: ProviderConfig = { ...bedrock };
  if (!out.region && resolved.region) out.region = resolved.region;
  switch (resolved.method) {
    case 'bearer_token':
      out.bearer_token = resolved.bearerToken;
      break;
    case 'access_keys':
      out.aws_access_key_id = resolved.accessKeyId;
      out.aws_secret_access_key = resolved.secretAccessKey;
      break;
    case 'profile':
      out.aws_profile = resolved.profile;
      break;
    case 'credential_process':
      // Surface the command; the adapter runs + caches + refreshes it.
      out.aws_credential_export = resolved.credentialExportCmd;
      break;
    // 'aws_chain' / null: leave as-is — default credential chain applies.
  }
  return out;
}

/**
 * Synthesize a providers map from legacy config fields.
 * Called when config has no `providers` section — backward compat AND the
 * fresh-install path (no providers yet), which is exactly when onboarding
 * matters. We seed only the region here and let buildProviderMap fill the
 * Bedrock auth via the unified resolver, so settings.json/env/~/.aws are all
 * considered with one consistent priority (rather than env-only here).
 */
export function synthesizeFromLegacy(config: Config & { agent?: { region?: string } }): Record<string, ProviderConfig> {
  const region = config.provider?.bedrock_region
    ?? (config.agent as { region?: string } | undefined)?.region
    ?? undefined; // resolver fills the env/default region when this is absent

  const providers: Record<string, ProviderConfig> = {
    bedrock: { api: 'bedrock', ...(region ? { region } : {}) },
  };

  // buildProviderMap auto-detects other providers from env AND fills Bedrock auth
  // from the unified resolver (settings.json → env → ~/.aws).
  return buildProviderMap(providers, config as Config);
}

/**
 * Reset all cached adapter instances. Useful for credential refresh.
 */
export function resetAllAdapters(): void {
  for (const adapter of adapterCache.values()) {
    adapter.resetClient();
  }
  adapterCache.clear();
  log.agent.info('all provider adapters reset');
}

/**
 * List all available provider names (for UI display).
 */
export function listProviders(providers: Record<string, ProviderConfig>): string[] {
  return Object.keys(providers);
}
