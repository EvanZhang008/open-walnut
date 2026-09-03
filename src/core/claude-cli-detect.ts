/**
 * Boolean-only detection of the Claude Code CLI and its subscription auth state.
 *
 * SECURITY RED LINE: this module NEVER reads the value of any OAuth/subscription
 * token. It only answers yes/no questions:
 *   - Is the `claude` binary available on PATH or in a standard user bin dir?
 *   - Does a subscription credential EXIST (keychain item on macOS, or the
 *     `.credentials.json` file elsewhere)?
 * We mirror the credential-resolver's `probeAwsFiles` pattern (best-effort
 * existence checks, never content reads). On macOS we ask the keychain only for
 * an EXIT CODE (`security find-generic-password -s <svc>` with no `-w`), so the
 * secret value is never emitted, printed, or returned.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_CREDENTIALS_FILE } from '../constants.js';

/** Keychain service name Claude Code stores its OAuth (subscription) token under.
 *  Verified against the fork: `Claude Code${OAUTH_FILE_SUFFIX}${'-credentials'}`
 *  where the default (production) OAUTH_FILE_SUFFIX is ''. */
const KEYCHAIN_OAUTH_SERVICE = 'Claude Code-credentials';

/** Resolve the CLI exactly as Walnut's daemon does: inherited PATH first, then
 * standard per-user install directories that service processes often omit. */
export function resolveClaudeCliExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const home = env.HOME || os.homedir();
  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const fallbackDirs = [
    path.join(home, '.toolbox', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
  ];

  for (const dir of [...new Set([...pathDirs, ...fallbackDirs])]) {
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** True when the `claude` binary is available to Walnut. */
export function isClaudeCliInstalled(): boolean {
  return resolveClaudeCliExecutable() !== null;
}

/**
 * True when a Claude Code subscription (OAuth) credential EXISTS.
 *
 * We do NOT read the token — only its existence:
 *   - macOS: `security find-generic-password -s "Claude Code-credentials"`.
 *     We pass NO `-w` flag, so the value is never printed; we read only the
 *     exit code (0 = present). stdio is fully ignored.
 *   - other platforms / fallback: existence of `~/.claude/.credentials.json`.
 *
 * Best-effort: any error → false. Never throws.
 */
export function hasClaudeSubscriptionAuth(): boolean {
  // Platform-native store first (macOS keychain).
  if (process.platform === 'darwin') {
    try {
      // -s selects the service; NO -w means the password value is NOT emitted.
      // We only care about the exit code (throws on not-found).
      execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_OAUTH_SERVICE], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      // Fall through to the file probe — some setups keep the JSON store even
      // on macOS (e.g. CLAUDE_CONFIG_DIR overrides, headless installs).
    }
  }
  return fileCredentialExists();
}

/** Best-effort existence check of the JSON credential store. No content read. */
function fileCredentialExists(): boolean {
  try {
    return fs.existsSync(CLAUDE_CREDENTIALS_FILE);
  } catch {
    return false;
  }
}

/**
 * Snapshot of what the local Claude Code install can offer the Personal AI as a
 * zero-config provider. `subscriptionReady` gates the text-only `claude-cli`
 * provider (Phase 2).
 */
export interface ClaudeCliCapabilities {
  /** `claude` binary is available on PATH or in a standard user install directory. */
  installed: boolean;
  /** A subscription OAuth credential exists (existence only, value never read). */
  subscriptionAuth: boolean;
  /** Both installed AND a subscription credential exists. */
  subscriptionReady: boolean;
  /**
   * The `claude_cli` provider can answer: the binary is here. Its auth is the
   * CLI's own business (subscription, Bedrock, Vertex, an API key — whatever the
   * user's Claude Code already uses), so nothing beyond the binary gates it.
   */
  ready: boolean;
  /** How that Claude Code appears to be signed in, for display only: see describeClaudeCliAuth. */
  auth: ClaudeCliAuthHint;
}

export function detectClaudeCli(): ClaudeCliCapabilities {
  const installed = isClaudeCliInstalled();
  const subscriptionAuth = installed && hasClaudeSubscriptionAuth();
  return {
    installed,
    subscriptionAuth,
    subscriptionReady: installed && subscriptionAuth,
    ready: installed,
    auth: installed ? describeClaudeCliAuth() : { mode: 'unknown', label: 'not installed' },
  };
}

export interface ClaudeCliAuthHint {
  mode: 'bedrock' | 'vertex' | 'api-key' | 'subscription' | 'unknown';
  /** One short phrase for the UI, e.g. "Bedrock (us-west-2)" or "your Claude subscription". */
  label: string;
}

/**
 * Which way the user's Claude Code signs in, read the way the CLI itself decides:
 * ~/.claude/settings.json's `env` block is assigned over the process env, then
 * CLAUDE_CODE_USE_BEDROCK / USE_VERTEX / an API key / the OAuth store decide.
 * Existence and flag values only; no credential value is ever read or returned.
 */
export function describeClaudeCliAuth(
  env: NodeJS.ProcessEnv = process.env,
  settingsEnv: Record<string, string> = readClaudeSettingsEnv(),
): ClaudeCliAuthHint {
  const merged: Record<string, string | undefined> = { ...env, ...settingsEnv };
  const truthy = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false';
  if (truthy(merged.CLAUDE_CODE_USE_BEDROCK)) {
    const region = merged.AWS_REGION || merged.AWS_DEFAULT_REGION;
    return { mode: 'bedrock', label: region ? `Bedrock (${region})` : 'Bedrock' };
  }
  if (truthy(merged.CLAUDE_CODE_USE_VERTEX)) return { mode: 'vertex', label: 'Vertex AI' };
  if (merged.ANTHROPIC_API_KEY || merged.ANTHROPIC_AUTH_TOKEN) return { mode: 'api-key', label: 'an Anthropic API key' };
  if (hasClaudeSubscriptionAuth()) return { mode: 'subscription', label: 'your Claude subscription' };
  return { mode: 'unknown', label: 'its own login' };
}

/** The `env` block of ~/.claude/settings.json (string values only); {} when absent. */
function readClaudeSettingsEnv(): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    const env = (JSON.parse(raw) as { env?: Record<string, unknown> }).env ?? {};
    return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

// Re-export the keychain home for tests that need to know which store we probe
// (kept internal otherwise). Tests never read a value either.
export const _CLAUDE_CREDENTIALS_HOME = os.homedir();
