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
 * Snapshot of what the local Claude Code install can offer the butler as a
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
}

export function detectClaudeCli(): ClaudeCliCapabilities {
  const installed = isClaudeCliInstalled();
  const subscriptionAuth = installed && hasClaudeSubscriptionAuth();
  return {
    installed,
    subscriptionAuth,
    subscriptionReady: installed && subscriptionAuth,
  };
}

// Re-export the keychain home for tests that need to know which store we probe
// (kept internal otherwise). Tests never read a value either.
export const _CLAUDE_CREDENTIALS_HOME = os.homedir();
