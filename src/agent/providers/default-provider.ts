/**
 * Which provider answers when config names none.
 *
 * Every background model call (titles, summaries, subagents, the in-process
 * loop) used to fall back to 'bedrock', so a machine with nothing but Claude Code
 * on it looked "unconfigured" and asked for AWS keys it never needed. This is the
 * ONE provider choice (Settings → AI Provider): what Ask Walnut runs on. The chat
 * engine follows it (config-manager's resolveAgentEngineProvider), and so do the
 * helpers: if `claude` is installed, the `claude_cli` provider drives them with
 * the CLI's own login, whatever that is.
 *
 * Precedence, first match wins:
 *   1. `agent.main_provider` set explicitly: the user's word.
 *   2. The `claude` binary is installed: 'claude_cli'. Bedrock credentials saved in
 *      Walnut's config do NOT outrank this: a machine with Claude Code on it runs on
 *      Claude Code, full stop (the saved credentials stay usable the moment the user
 *      picks Bedrock in Settings, which writes `agent.main_provider`).
 *   3. 'bedrock' (the historical default; the SDK's credential chain may still work).
 */
import type { Config } from '../../core/types.js';
import { isClaudeCliInstalled } from '../../core/claude-cli-detect.js';

export const LEGACY_DEFAULT_PROVIDER = 'bedrock';
export const CLAUDE_CLI_PROVIDER = 'claude_cli';

/** The binary probe stats a handful of paths; once a minute is plenty. */
const CLI_PROBE_TTL_MS = 60_000;
let cliProbe: { at: number; installed: boolean } | undefined;
function claudeCliInstalledCached(): boolean {
  const now = Date.now();
  if (!cliProbe || now - cliProbe.at > CLI_PROBE_TTL_MS) {
    cliProbe = { at: now, installed: isClaudeCliInstalled() };
  }
  return cliProbe.installed;
}

/** Test hook: forget the cached binary probe. */
export function _resetDefaultProviderCacheForTesting(): void {
  cliProbe = undefined;
}

/** True when Walnut's own config carries Bedrock credentials (not env, not ~/.aws). */
export function hasExplicitBedrockConfig(config: Config): boolean {
  const b = config.providers?.bedrock;
  if (b && (b.bearer_token || b.aws_access_key_id || b.aws_profile || b.aws_credential_export)) return true;
  return !!config.provider?.bedrock_bearer_token;
}

/**
 * The provider name background calls should use. Pass `claudeInstalled` to
 * bypass the filesystem probe (tests, or callers that already know).
 */
export function resolveMainProviderName(
  config: Config,
  claudeInstalled: boolean = claudeCliInstalledCached(),
): string {
  if (config.agent?.main_provider) return config.agent.main_provider;
  if (claudeInstalled) return CLAUDE_CLI_PROVIDER;
  return LEGACY_DEFAULT_PROVIDER;
}

/** Whether the effective provider is the one config left implicit (for the UI's "(default)" tag). */
export function mainProviderIsImplicit(config: Config): boolean {
  return !config.agent?.main_provider;
}
