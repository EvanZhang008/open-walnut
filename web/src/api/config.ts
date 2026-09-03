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

/**
 * Whether the server can hand a local path to the desktop (`open`) — macOS
 * console only, false on cloud replicas. Drives whether the file-explorer's
 * right-click menu offers Reveal in Finder / Open in default app. Same
 * page-lifetime cache rationale as installDir (platform can't change).
 */
let _canRevealPromise: Promise<boolean> | null = null;
export function fetchCanRevealLocalFiles(): Promise<boolean> {
  _canRevealPromise ??= apiGet<{ canRevealLocalFiles?: boolean }>('/api/config')
    .then(res => res.canRevealLocalFiles === true)
    .catch(() => { _canRevealPromise = null; return false; });
  return _canRevealPromise;
}

/**
 * Whether this server is a cloud replica (WALNUT_CLOUD_MODE=1). A replica has
 * no CLI and no local daemon, so surfaces that would start local work (e.g.
 * "Build a plugin") hide their action and point at the Mac instead. Same
 * page-lifetime cache rationale as installDir (the mode can't change without
 * a server restart); errors resolve false so the primary console never loses
 * the affordance to a flaky fetch.
 */
let _cloudPromise: Promise<boolean> | null = null;
export function fetchIsCloudReplica(): Promise<boolean> {
  _cloudPromise ??= apiGet<{ cloud?: boolean }>('/api/config')
    .then(res => res.cloud === true)
    .catch(() => { _cloudPromise = null; return false; });
  return _cloudPromise;
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
  // claude-cli: 'cli_bedrock' | 'cli_vertex' | 'cli_api-key' | 'cli_subscription' | 'cli_unknown' | 'cli_not_installed'
  credential_source?: string;
  // claude-cli: how the CLI signs in, e.g. "Bedrock (us-west-2)" or "your Claude subscription"
  credential_detail?: string;
}

export async function fetchProviders(): Promise<Record<string, ProviderStatus>> {
  const res = await apiGet<{ providers: Record<string, ProviderStatus> }>('/api/config/providers');
  return res.providers;
}

// ── Credential resolution trace (Bedrock transparency panel) ──

export interface CredentialTraceStep {
  step: number;
  owner: 'walnut' | 'claude-code' | 'shell-env' | 'aws-cli';
  source: string;
  location: string;
  checkedFor: string[];
  outcome: 'won' | 'empty' | 'not-reached';
  found?: { method: string; detail?: string; keyHint?: string; value?: string };
}

export interface CredentialTrace {
  steps: CredentialTraceStep[];
  winner: {
    source: string;
    method: string | null;
    detail?: string;
    keyHint?: string;
    profile?: string;
    credentialExportCmd?: string;
    region?: string;
  };
  region: { value: string; source: string };
}

export interface CredentialVerify {
  status: 'valid' | 'invalid' | 'unverifiable' | 'skipped';
  arn?: string;
  account?: string;
  expiration?: string;
  error?: string;
  latencyMs: number;
}

export async function fetchCredentialTrace(verify = false): Promise<{ trace: CredentialTrace; verify?: CredentialVerify }> {
  return apiGet<{ trace: CredentialTrace; verify?: CredentialVerify }>(
    `/api/config/credential-trace${verify ? '?verify=1' : ''}`,
  );
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
