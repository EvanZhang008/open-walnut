/**
 * Secret resolution for provider API keys.
 *
 * Supports three syntaxes:
 *   1. Literal value: "sk-ant-abc123"
 *   2. Env var reference: "${env:ANTHROPIC_API_KEY}"
 *   3. Plain env var name: "ANTHROPIC_API_KEY" (auto-resolved if it looks like an env var)
 *
 * Resolution order for a provider:
 *   1. Explicit api_key in config (resolved via ${env:} if needed)
 *   2. Auto-detect from environment: {PROVIDER_NAME}_API_KEY
 *   3. Fall back to protocol-specific defaults (e.g., AWS credential chain for Bedrock)
 */

const ENV_REF_PATTERN = /^\$\{env:([^}]+)\}$/;
const LOOKS_LIKE_ENV_VAR = /^[A-Z][A-Z0-9_]+$/;

/**
 * Resolve a single secret value. Returns undefined if the value resolves to empty.
 */
export function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;

  // 1. ${env:VAR_NAME} syntax
  const envMatch = value.match(ENV_REF_PATTERN);
  if (envMatch) {
    return process.env[envMatch[1]] || undefined;
  }

  // 2. Plain env var name (all uppercase + underscores, starts with letter)
  if (LOOKS_LIKE_ENV_VAR.test(value) && process.env[value]) {
    return process.env[value];
  }

  // 3. Literal value
  return value;
}

/**
 * Auto-detect API key from environment for a provider name.
 * Tries: {PROVIDER}_API_KEY, {PROVIDER_UPPER}_API_KEY
 */
export function autoDetectApiKey(providerName: string): string | undefined {
  const upper = providerName.toUpperCase().replace(/-/g, '_');
  return process.env[`${upper}_API_KEY`] || undefined;
}

/**
 * Resolve all secret fields in a provider config object.
 * Returns a new object with secrets resolved (does not mutate input).
 */
export function resolveProviderSecrets(
  config: import('./types.js').ProviderConfig,
  providerName: string,
): import('./types.js').ProviderConfig {
  const resolved = { ...config };

  // Resolve api_key
  if (typeof resolved.api_key === 'string') {
    resolved.api_key = resolveSecret(resolved.api_key);
  }
  // Auto-detect if still missing
  if (!resolved.api_key) {
    const auto = autoDetectApiKey(providerName);
    if (auto) resolved.api_key = auto;
  }

  // Resolve bearer_token (Bedrock)
  if (typeof resolved.bearer_token === 'string') {
    resolved.bearer_token = resolveSecret(resolved.bearer_token);
  }

  return resolved;
}
