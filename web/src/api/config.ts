import { apiGet, apiPut, apiPost } from './client';
import type { Config } from '@open-walnut/core';

export async function fetchConfig(): Promise<Config & { _envTokenHint?: string }> {
  const res = await apiGet<{ config: Config; envTokenHint?: string }>('/api/config');
  // Attach env hint as a transient field
  if (res.envTokenHint) (res.config as Config & { _envTokenHint?: string })._envTokenHint = res.envTokenHint;
  return res.config;
}

/**
 * Whether an error notification's "Ask AI to fix" can start a repair session
 * here, and in which source tree. `source: null` with `available: true` means
 * the first click has to CLONE upstream first (minutes, once), and the button says
 * so instead of looking hung. `available: false` carries a `reason` and the
 * affordance simply isn't rendered (same posture as the Fix Walnut pill).
 */
export interface SelfRepairInfo {
  available: boolean;
  source: { dir: string; kind: 'running' | 'configured' | 'clone' } | null;
  cloneDir: string;
  repoUrl: string;
  reason?: string;
}

/** Which build the server runs (server: src/lib/build-info.ts). Nulls = running from source. */
export interface BuildInfo {
  version: string;
  commit: string | null;
  branch: string | null;
  builtAt: string | null;
  dirty: boolean;
}

/** The page-lifetime facts GET /api/config carries next to the config itself. */
interface ServerFacts {
  installDir?: string | null;
  selfRepair?: SelfRepairInfo | null;
  notesDir?: string | null;
  canRevealLocalFiles?: boolean;
  cloud?: boolean;
  build?: BuildInfo | null;
}

/**
 * ONE shared GET /api/config for every page-lifetime helper below. The route is
 * not cheap (self-repair probe, memory stats, asset report), and these helpers
 * all fire in the same cold-load fan-out, so each owning its own fetch cost one
 * full request apiece. None of these facts can change without a server restart
 * (which reloads the page); the one exception, selfRepair after a first clone,
 * drops the shared answer via invalidateSelfRepair(). A failed fetch is dropped
 * too, so the next caller retries, and every selector resolves its fallback.
 */
let _factsPromise: Promise<ServerFacts> | null = null;
let _facts: ServerFacts | null = null;
function serverFacts(): Promise<ServerFacts> {
  if (!_factsPromise) {
    const p: Promise<ServerFacts> = apiGet<ServerFacts>('/api/config')
      .then(res => { if (_factsPromise === p) _facts = res; return res; })
      .catch(err => { if (_factsPromise === p) _factsPromise = null; throw err; });
    _factsPromise = p;
  }
  return _factsPromise;
}
function selectFact<T>(pick: (facts: ServerFacts) => T, fallback: T): Promise<T> {
  return serverFacts().then(pick, () => fallback);
}

/** Test hook: forget the shared answer. */
export function _resetServerFactsForTest(): void {
  _factsPromise = null;
  _facts = null;
}

/**
 * Walnut's own source checkout (drives the "Fix Walnut" button). null on npm
 * installs / cloud replicas → the button hides.
 */
export function fetchInstallDir(): Promise<string | null> {
  return selectFact(f => f.installDir ?? null, null);
}

/** The first repair on an npm install CLONES a source tree, which flips `source`
 *  from null to a path. `startNotificationFix` calls invalidateSelfRepair() when
 *  its result says `cloned`, so the next card stops promising a clone that
 *  already happened. */
export function fetchSelfRepair(): Promise<SelfRepairInfo | null> {
  return selectFact(f => f.selfRepair ?? null, null);
}
export function invalidateSelfRepair(): void {
  _factsPromise = null;
}

/** Notes vault root (cwd for Claude Code sessions started from /notes). null in cloud mode. */
export function fetchNotesDir(): Promise<string | null> {
  return selectFact(f => f.notesDir ?? null, null);
}

/**
 * Whether the server can hand a local path to the desktop (`open`): macOS
 * console only, false on cloud replicas. Drives whether the file-explorer's
 * right-click menu offers Reveal in Finder / Open in default app.
 */
export function fetchCanRevealLocalFiles(): Promise<boolean> {
  return selectFact(f => f.canRevealLocalFiles === true, false);
}

/**
 * Whether this server is a cloud replica (WALNUT_CLOUD_MODE=1). A replica has
 * no CLI and no local daemon, so surfaces that would start local work (e.g.
 * "Build a plugin") hide their action and point at the Mac instead. Errors
 * resolve false so the primary console never loses the affordance to a flaky fetch.
 */
export function fetchIsCloudReplica(): Promise<boolean> {
  return selectFact(f => f.cloud === true, false);
}

/** Build identity for the Settings footer line. */
export function fetchBuildInfo(): Promise<BuildInfo | null> {
  return selectFact(f => f.build ?? null, null);
}
/** The build identity if already fetched, so a remounting view never flashes empty. */
export function peekBuildInfo(): BuildInfo | null {
  return _facts?.build ?? null;
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
