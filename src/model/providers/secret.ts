/**
 * Secret resolution for provider API keys.
 *
 * Supports four syntaxes:
 *   1. Literal value: "sk-ant-abc123"
 *   2. Env var reference: "${env:ANTHROPIC_API_KEY}"
 *   3. Plain env var name: "ANTHROPIC_API_KEY" (auto-resolved if it looks like an env var)
 *   4. File reference: "${file:~/.open-walnut/secrets/some.key}" for keys that
 *      must stay OUT of the synced config file. Confined to <walnut-home>/secrets/
 *      (the git-sync-excluded dir); anything else resolves to undefined, loudly.
 *
 * Resolution order for a provider:
 *   1. Explicit api_key in config (resolved via ${env:} if needed)
 *   2. Auto-detect from environment: {PROVIDER_NAME}_API_KEY
 *   3. Fall back to protocol-specific defaults (e.g., AWS credential chain for Bedrock)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

const ENV_REF_PATTERN = /^\$\{env:([^}]+)\}$/;
const FILE_REF_PATTERN = /^\$\{file:([^}]+)\}$/;
const LOOKS_LIKE_ENV_VAR = /^[A-Z][A-Z0-9_]+$/;

/**
 * Read a ${file:} secret. CONFINED to <walnut-home>/secrets/: config.yaml is
 * writable over the API and rides git-sync, and the endpoint next to a key
 * field is equally config-controlled, so an unconfined ${file:} would turn a
 * config write into "read any host file and POST it to a chosen endpoint as a
 * Bearer token". The secrets dir is also exactly what the syntax is for (it is
 * git-sync-excluded). Every failure LOGS: callers treat undefined as "not
 * configured", and a silent undefined makes a typo'd path indistinguishable
 * from no configuration at all.
 */
function readSecretFile(raw: string): string | undefined {
  let p = raw;
  if (p === '~' || p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(1));
  } else if (p.startsWith('~')) {
    // '~user/x' silently resolving under $HOME is how misconfigurations hide.
    log.web.warn('${file:} secret ref rejected: ~user paths are not supported', { ref: raw });
    return undefined;
  }
  const secretsDir = path.join(WALNUT_HOME, 'secrets');
  const resolved = path.resolve(p);
  if (!resolved.startsWith(secretsDir + path.sep)) {
    log.web.warn('${file:} secret ref rejected: path must live under the secrets dir', {
      ref: raw, secretsDir,
    });
    return undefined;
  }
  try {
    return fs.readFileSync(resolved, 'utf8').trim() || undefined;
  } catch (err) {
    log.web.warn('${file:} secret file unreadable', {
      ref: raw,
      errorKind: err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.name) : typeof err,
    });
    return undefined;
  }
}

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

  // 1b. ${file:path} syntax — read the key from a file under the secrets dir
  // (see readSecretFile). Unresolvable refs come back undefined, same contract
  // as an unset env var: the caller reports "not configured".
  const fileMatch = value.match(FILE_REF_PATTERN);
  if (fileMatch) {
    return readSecretFile(fileMatch[1].trim());
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
