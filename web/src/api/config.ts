import { apiGet, apiPut, apiPost } from './client';
import type { Config } from '@open-walnut/core';

export async function fetchConfig(): Promise<Config & { _envTokenHint?: string }> {
  const res = await apiGet<{ config: Config; envTokenHint?: string }>('/api/config');
  // Attach env hint as a transient field
  if (res.envTokenHint) (res.config as Config & { _envTokenHint?: string })._envTokenHint = res.envTokenHint;
  return res.config;
}

/**
 * Walnut's own source checkout (drives the "Fix Walnut" button). null on npm
 * installs / cloud replicas → the button hides. Cached for the page lifetime:
 * the install dir can't change without a server restart.
 */
let _installDirPromise: Promise<string | null> | null = null;
export function fetchInstallDir(): Promise<string | null> {
  _installDirPromise ??= apiGet<{ installDir?: string | null }>('/api/config')
    .then(res => res.installDir ?? null)
    .catch(() => { _installDirPromise = null; return null; });
  return _installDirPromise;
}

/**
 * Notes vault root (cwd for Claude Code sessions started from /notes). null in
 * cloud mode. Same page-lifetime cache rationale as installDir.
 */
let _notesDirPromise: Promise<string | null> | null = null;
export function fetchNotesDir(): Promise<string | null> {
  _notesDirPromise ??= apiGet<{ notesDir?: string | null }>('/api/config')
    .then(res => res.notesDir ?? null)
    .catch(() => { _notesDirPromise = null; return null; });
  return _notesDirPromise;
}

export async function updateConfig(config: Partial<Config>): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>('/api/config', config);
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  authMethod?: string;
}

export async function testConnection(
  params: {
    bedrock_region?: string;
    bedrock_bearer_token?: string;
    bedrock_access_key?: string;
    bedrock_secret_key?: string;
    bedrock_profile?: string;
    bedrock_credential_export?: string;
  },
): Promise<TestConnectionResult> {
  return apiPost<TestConnectionResult>('/api/config/test-connection', params);
}

export async function fetchAwsProfiles(): Promise<string[]> {
  const res = await apiGet<{ profiles: string[] }>('/api/config/aws-profiles');
  return res.profiles;
}

// ── Multi-provider API ──

export interface ModelEntry {
  id: string;
  provider: string;
  label?: string;
  max_tokens?: number;
  context_window?: number;
}

export interface ProviderStatus {
  api: string;
  base_url?: string;
  status: 'ready' | 'no_key' | 'not_implemented';
  key_hint?: string;
  auto_detected: boolean;
  models: ModelEntry[];
  // bedrock: 'bearer_token' | 'access_keys' | 'profile' | 'credential_process' | 'aws_env' | 'aws_credentials_file' | 'aws_config_file'
  // claude-cli: 'subscription' | 'cli_no_subscription' | 'cli_not_installed'
  credential_source?: string;
}

export async function fetchProviders(): Promise<Record<string, ProviderStatus>> {
  const res = await apiGet<{ providers: Record<string, ProviderStatus> }>('/api/config/providers');
  return res.providers;
}

export async function testProvider(
  providerName: string,
  providerConfig?: { api: string; api_key?: string; base_url?: string; region?: string; bearer_token?: string },
): Promise<TestConnectionResult> {
  return apiPost<TestConnectionResult>('/api/config/test-provider', {
    provider_name: providerName,
    provider_config: providerConfig,
  });
}
