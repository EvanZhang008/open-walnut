/**
 * Unified Bedrock credential resolver.
 *
 * Walnut's main agent (the butler) talks to Bedrock directly via the SDK
 * (src/agent/providers/adapter-bedrock.ts) — it does NOT go through the
 * `claude` CLI. So "make Walnut usable on first launch" reduces to "resolve
 * one Bedrock credential". This module is the single source of truth for that.
 *
 * Priority chain (highest → lowest):
 *   1. config.yaml          — explicit user choice (providers.bedrock / legacy provider.*)
 *   2. ~/.claude/settings.json `env` block — the auth Claude Code itself uses
 *   3. process.env          — AWS_BEARER_TOKEN_BEDROCK / access keys / AWS_PROFILE
 *   4. ~/.aws/{credentials,config} — default AWS credential chain
 *
 * The credential *material* (bearer token / access keys / profile) is resolved
 * by priority. The *region* is resolved independently by the same priority, so
 * a user who set only a region in config still gets their region even when the
 * key comes from a lower source.
 *
 * The core (`resolveCredentialFrom`) is a pure function over plain data so it's
 * trivially unit-testable. `resolveCredentials()` is the thin wrapper that reads
 * the real settings.json + process.env + ~/.aws.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CLAUDE_SETTINGS_FILE } from '../constants.js';
import { log } from '../logging/index.js';
import type { Config } from './types.js';

/** Which source the winning credential came from (for UI display + transparency). */
export type CredentialSource = 'config' | 'claude-settings' | 'env' | 'aws-files' | 'none';

/** How Bedrock will authenticate, derived from whatever was found. */
export type CredentialMethod = 'bearer_token' | 'access_keys' | 'profile' | 'aws_chain';

export const DEFAULT_REGION = 'us-west-2';

/** The resolved Bedrock credential + provenance. */
export interface ResolvedCredential {
  /** Where the credential material came from. 'none' = nothing usable found. */
  source: CredentialSource;
  /** How Bedrock will authenticate. */
  method: CredentialMethod | null;
  /** Effective region (always set unless source==='none'). */
  region?: string;
  /** Bedrock bearer token (Identity Center / SSO). */
  bearerToken?: string;
  /** Explicit IAM access key. */
  accessKeyId?: string;
  /** Explicit IAM secret key. */
  secretAccessKey?: string;
  /** AWS profile name from ~/.aws/config. */
  profile?: string;
  /** Short human-readable provenance, e.g. "AWS_BEARER_TOKEN_BEDROCK" or "profile: dev". */
  detail?: string;
}

/** An env-like bag of strings (process.env or settings.json's `env` block). */
type EnvBag = Record<string, string | undefined>;

/** Pure inputs for the resolver — all sources as plain data. */
export interface ResolveInputs {
  config: Config;
  /** The `env` block from ~/.claude/settings.json (already parsed). */
  claudeEnv: EnvBag;
  /** process.env (or a fake in tests). */
  processEnv: EnvBag;
  /** Existence of the two ~/.aws files. */
  awsFiles: { credentials: boolean; config: boolean };
}

/** Region resolved from an env-like bag (AWS_REGION wins over AWS_DEFAULT_REGION). */
function regionFromEnv(env: EnvBag): string | undefined {
  return env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined;
}

/**
 * Extract a Bedrock auth method from an env-like bag.
 * Order within a single bag: bearer token → explicit access keys → profile.
 * Returns null if the bag carries no usable auth material.
 */
function authFromEnv(env: EnvBag): Pick<ResolvedCredential, 'method' | 'bearerToken' | 'accessKeyId' | 'secretAccessKey' | 'profile' | 'detail'> | null {
  if (env.AWS_BEARER_TOKEN_BEDROCK) {
    return { method: 'bearer_token', bearerToken: env.AWS_BEARER_TOKEN_BEDROCK, detail: 'AWS_BEARER_TOKEN_BEDROCK' };
  }
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      method: 'access_keys',
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      detail: 'AWS_ACCESS_KEY_ID',
    };
  }
  if (env.AWS_PROFILE) {
    return { method: 'profile', profile: env.AWS_PROFILE, detail: `profile: ${env.AWS_PROFILE}` };
  }
  return null;
}

/** Extract Bedrock auth from config.yaml (new `providers.bedrock` or legacy `provider.*`). */
function authFromConfig(config: Config): Pick<ResolvedCredential, 'method' | 'bearerToken' | 'accessKeyId' | 'secretAccessKey' | 'profile' | 'detail'> | null {
  const b = config.providers?.bedrock;
  if (b) {
    if (b.bearer_token) return { method: 'bearer_token', bearerToken: b.bearer_token, detail: 'config.providers.bedrock.bearer_token' };
    if (b.aws_access_key_id && b.aws_secret_access_key) {
      return {
        method: 'access_keys',
        accessKeyId: b.aws_access_key_id,
        secretAccessKey: b.aws_secret_access_key,
        detail: 'config.providers.bedrock access keys',
      };
    }
    if (b.aws_profile) return { method: 'profile', profile: b.aws_profile, detail: `config profile: ${b.aws_profile}` };
  }
  // Legacy single-provider field
  if (config.provider?.bedrock_bearer_token) {
    return { method: 'bearer_token', bearerToken: config.provider.bedrock_bearer_token, detail: 'config.provider.bedrock_bearer_token' };
  }
  return null;
}

/** Region from config.yaml (new providers.bedrock.region or legacy provider.bedrock_region). */
function regionFromConfig(config: Config): string | undefined {
  return config.providers?.bedrock?.region || config.provider?.bedrock_region || undefined;
}

/**
 * Pure resolver: pick the winning Bedrock credential + region across all sources
 * by priority. No I/O — feed it data, get a decision. Unit-test this directly.
 */
export function resolveCredentialFrom(inputs: ResolveInputs): ResolvedCredential {
  const { config, claudeEnv, processEnv, awsFiles } = inputs;

  // Region: independent priority chain so a config-only region still applies
  // even when the key comes from a lower source. Falls back to the default.
  const region =
    regionFromConfig(config) ||
    regionFromEnv(claudeEnv) ||
    regionFromEnv(processEnv) ||
    DEFAULT_REGION;

  // Credential material: first source that yields auth wins.
  const ladder: Array<{ source: CredentialSource; auth: ReturnType<typeof authFromEnv> }> = [
    { source: 'config', auth: authFromConfig(config) },
    { source: 'claude-settings', auth: authFromEnv(claudeEnv) },
    { source: 'env', auth: authFromEnv(processEnv) },
  ];

  for (const { source, auth } of ladder) {
    if (auth) return { source, region, ...auth };
  }

  // Last resort: a populated ~/.aws lets the SDK's default credential chain work.
  if (awsFiles.credentials || awsFiles.config) {
    return {
      source: 'aws-files',
      method: 'aws_chain',
      region,
      detail: awsFiles.credentials ? '~/.aws/credentials' : '~/.aws/config',
    };
  }

  return { source: 'none', method: null };
}

/** Read & parse the `env` block from ~/.claude/settings.json. Best-effort. */
export function readClaudeSettingsEnv(settingsFile: string = CLAUDE_SETTINGS_FILE): EnvBag {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    if (!parsed.env || typeof parsed.env !== 'object') return {};
    const out: EnvBag = {};
    for (const [k, v] of Object.entries(parsed.env)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    // Missing / malformed settings.json → no env block. Silent, like plugin-skill-loader.
    return {};
  }
}

/** Best-effort existence check of the two ~/.aws files. */
function probeAwsFiles(): { credentials: boolean; config: boolean } {
  const home = os.homedir();
  const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };
  return {
    credentials: exists(path.join(home, '.aws', 'credentials')),
    config: exists(path.join(home, '.aws', 'config')),
  };
}

/**
 * Resolve the Bedrock credential Walnut should use, reading the real sources.
 * This is the public entry point used by the provider registry, the health
 * check, and the onboarding UI.
 */
export function resolveCredentials(config: Config): ResolvedCredential {
  const result = resolveCredentialFrom({
    config,
    claudeEnv: readClaudeSettingsEnv(),
    processEnv: process.env,
    awsFiles: probeAwsFiles(),
  });
  if (result.source !== 'none') {
    log.session.debug('credential-resolver: resolved Bedrock credential', {
      source: result.source,
      method: result.method,
      region: result.region,
    });
  }
  return result;
}

/** True when Walnut has a usable Bedrock credential from any source. */
export function hasResolvableCredential(config: Config): boolean {
  return resolveCredentials(config).source !== 'none';
}
