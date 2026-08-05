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

/** How Bedrock will authenticate, derived from whatever was found.
 *  `credential_process` = a shell command that prints temporary AWS creds as
 *  JSON; the resolver only surfaces the command string — the adapter runs it,
 *  caches the result, and re-runs on expiry (see adapter-bedrock.ts). */
export type CredentialMethod = 'bearer_token' | 'access_keys' | 'profile' | 'credential_process' | 'aws_chain';

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
  /** Shell command that prints temporary AWS creds as JSON (method
   *  'credential_process'). The adapter runs + caches + refreshes it. */
  credentialExportCmd?: string;
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
  /** Top-level `awsCredentialExport` command from ~/.claude/settings.json, if any.
   *  A shell command that prints temporary AWS creds as JSON. The resolver only
   *  surfaces it; the adapter runs + caches + refreshes it. */
  claudeCredentialExport?: string;
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
function authFromConfig(config: Config): Pick<ResolvedCredential, 'method' | 'bearerToken' | 'accessKeyId' | 'secretAccessKey' | 'profile' | 'credentialExportCmd' | 'detail'> | null {
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
    if (b.aws_credential_export) return { method: 'credential_process', credentialExportCmd: b.aws_credential_export, detail: 'config.providers.bedrock.aws_credential_export' };
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

/** One rung of the resolution ladder, with the metadata the trace UI displays. */
interface LadderRung {
  source: CredentialSource;
  /** Which tool owns this source — the "is this Claude Code's or Walnut's?" answer. */
  owner: 'walnut' | 'claude-code' | 'shell-env' | 'aws-cli';
  /** File path / pseudo-path the rung reads. */
  location: string;
  /** Field names this rung inspects, for the "what did we look for" display. */
  checkedFor: string[];
  auth: Pick<ResolvedCredential, 'method' | 'bearerToken' | 'accessKeyId' | 'secretAccessKey' | 'profile' | 'credentialExportCmd' | 'detail'> | null;
}

/**
 * Build the shared resolution ladder. Order IS the priority contract:
 * config.yaml → settings.json env block → process.env → settings.json
 * awsCredentialExport. The settings.json top-level `awsCredentialExport` sits
 * BELOW env-block static creds (bearer/keys/profile) so an existing user's
 * explicit auth keeps winning, but ABOVE the bare ~/.aws chain — it's the
 * SSO/ada posture most internal users have.
 */
function buildLadder(inputs: ResolveInputs): LadderRung[] {
  const { config, claudeEnv, processEnv, claudeCredentialExport } = inputs;
  return [
    {
      source: 'config', owner: 'walnut',
      location: '~/.open-walnut/config.yaml',
      checkedFor: ['providers.bedrock.bearer_token', 'providers.bedrock.aws_access_key_id + aws_secret_access_key', 'providers.bedrock.aws_profile', 'providers.bedrock.aws_credential_export'],
      auth: authFromConfig(config),
    },
    {
      source: 'claude-settings', owner: 'claude-code',
      location: '~/.claude/settings.json (env block)',
      checkedFor: ['env.AWS_BEARER_TOKEN_BEDROCK', 'env.AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY', 'env.AWS_PROFILE'],
      auth: authFromEnv(claudeEnv),
    },
    {
      source: 'env', owner: 'shell-env',
      location: 'process environment (shell that launched Walnut)',
      checkedFor: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE'],
      auth: authFromEnv(processEnv),
    },
    {
      source: 'claude-settings', owner: 'claude-code',
      location: '~/.claude/settings.json (top-level awsCredentialExport)',
      checkedFor: ['awsCredentialExport'],
      auth: claudeCredentialExport
        ? { method: 'credential_process', credentialExportCmd: claudeCredentialExport, detail: 'settings.json awsCredentialExport' }
        : null,
    },
  ];
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
  for (const { source, auth } of buildLadder(inputs)) {
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

// ── Resolution trace (transparency for the settings UI) ──

/** Mask key material for display: keep the last 4 chars only. */
function maskTail(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.length > 4 ? `…${v.slice(-4)}` : '…';
}

/** One step of the trace as shown in the UI. Never carries secret values. */
export interface CredentialTraceStep {
  /** 1-based priority order. */
  step: number;
  /** Who owns this source: walnut | claude-code | shell-env | aws-cli. */
  owner: LadderRung['owner'];
  source: CredentialSource;
  /** File / pseudo-location this step reads. */
  location: string;
  /** Field names inspected at this step. */
  checkedFor: string[];
  /** 'won' = this step supplied the credential; 'empty' = inspected, nothing
   *  found; 'not-reached' = a higher step already won so this never ran. */
  outcome: 'won' | 'empty' | 'not-reached';
  /** When outcome==='won': what was found (masked, display-safe). */
  found?: {
    method: CredentialMethod;
    detail?: string;
    /** Last-4 hint of the key/token, when the method carries one. */
    keyHint?: string;
    /** The profile name / command string (not a secret). */
    value?: string;
  };
}

/** Full resolution trace: every step, the winner, and region provenance. */
export interface CredentialTrace {
  steps: CredentialTraceStep[];
  /** The same decision resolveCredentialFrom returns (secrets masked). */
  winner: {
    source: CredentialSource;
    method: CredentialMethod | null;
    detail?: string;
    keyHint?: string;
    profile?: string;
    credentialExportCmd?: string;
    region?: string;
  };
  region: { value: string; source: string };
}

/**
 * Trace variant of resolveCredentialFrom: same ladder, same winner, but returns
 * every step with its outcome so the UI can show exactly which file each layer
 * read, whether it was Claude Code's or Walnut's, and why the winner won.
 * Pure — no I/O; drive it with the same ResolveInputs.
 */
export function traceCredentialResolution(inputs: ResolveInputs): CredentialTrace {
  const { config, claudeEnv, processEnv, awsFiles } = inputs;

  const regionSource =
    regionFromConfig(config) ? '~/.open-walnut/config.yaml (providers.bedrock.region)'
    : regionFromEnv(claudeEnv) ? '~/.claude/settings.json env block (AWS_REGION)'
    : regionFromEnv(processEnv) ? 'process environment (AWS_REGION)'
    : `default (${DEFAULT_REGION})`;

  const winner = resolveCredentialFrom(inputs);

  const steps: CredentialTraceStep[] = [];
  let won = false;
  for (const rung of buildLadder(inputs)) {
    const outcome: CredentialTraceStep['outcome'] = won ? 'not-reached' : rung.auth ? 'won' : 'empty';
    const step: CredentialTraceStep = {
      step: steps.length + 1,
      owner: rung.owner,
      source: rung.source,
      location: rung.location,
      checkedFor: rung.checkedFor,
      outcome,
    };
    if (outcome === 'won' && rung.auth) {
      step.found = {
        method: rung.auth.method!,
        detail: rung.auth.detail,
        keyHint: maskTail(rung.auth.bearerToken ?? rung.auth.accessKeyId),
        value: rung.auth.profile ?? rung.auth.credentialExportCmd,
      };
      won = true;
    }
    steps.push(step);
  }

  // Rung 5: the ~/.aws existence fallback (checked only when nothing above won).
  const awsOutcome: CredentialTraceStep['outcome'] = won ? 'not-reached'
    : (awsFiles.credentials || awsFiles.config) ? 'won' : 'empty';
  steps.push({
    step: steps.length + 1,
    owner: 'aws-cli',
    source: 'aws-files',
    location: '~/.aws/credentials + ~/.aws/config',
    checkedFor: ['file exists (contents are NOT validated here — the AWS SDK default chain picks whichever profile applies at call time)'],
    outcome: awsOutcome,
    ...(awsOutcome === 'won' ? { found: { method: 'aws_chain' as CredentialMethod, detail: winner.detail } } : {}),
  });

  return {
    steps,
    winner: {
      source: winner.source,
      method: winner.method,
      detail: winner.detail,
      keyHint: maskTail(winner.bearerToken ?? winner.accessKeyId),
      profile: winner.profile,
      credentialExportCmd: winner.credentialExportCmd,
      region: winner.region,
    },
    region: { value: winner.region ?? DEFAULT_REGION, source: regionSource },
  };
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

/**
 * Read the top-level `awsCredentialExport` command from ~/.claude/settings.json.
 * Best-effort. SECURITY: we only ever read the USER-GLOBAL settings file
 * (CLAUDE_SETTINGS_FILE), never a project-level `.claude/settings.json`, so a
 * checked-out repo can't inject a command Walnut would execute — mirroring
 * Claude Code's own workspace-trust gate on this key.
 */
export function readClaudeCredentialExport(settingsFile: string = CLAUDE_SETTINGS_FILE): string | undefined {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const parsed = JSON.parse(raw) as { awsCredentialExport?: unknown };
    return typeof parsed.awsCredentialExport === 'string' && parsed.awsCredentialExport.trim()
      ? parsed.awsCredentialExport
      : undefined;
  } catch {
    return undefined;
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
    claudeCredentialExport: readClaudeCredentialExport(),
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
