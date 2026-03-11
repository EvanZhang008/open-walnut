/**
 * Configurable security policy for the exec tool.
 *
 * Supports three modes:
 *   - "full"      — any command runs; deny list still blocks matches (default)
 *   - "deny"      — deny list blocks matching commands
 *   - "allowlist" — only allow-listed commands may run
 *
 * Pattern matching uses simple glob syntax:
 *   - `*` matches any sequence of characters
 *   - `?` matches a single character
 */

export type ExecSecurityMode = 'full' | 'deny' | 'allowlist';

export interface ToolExecConfig {
  security?: ExecSecurityMode;
  deny?: string[];
  allow?: string[];
  timeout?: number;
  max_output?: number;
}

/**
 * Convert a simple glob pattern to a RegExp.
 * `*` → `.*`, `?` → `.`, everything else is escaped.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Check whether a command matches any of the given glob patterns.
 */
function matchesAny(command: string, patterns: string[]): string | undefined {
  for (const pattern of patterns) {
    if (globToRegex(pattern).test(command)) {
      return pattern;
    }
  }
  return undefined;
}

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Hard-coded safety rules that always apply, regardless of config.
 * Returns a rejection PolicyResult if the command is dangerous, or undefined if OK.
 *
 * NOTE: These are defense-in-depth heuristics, not a hard security boundary.
 * The session context warning (`<server_safety>` in session-context.ts) is the
 * primary defense. These regex patterns catch common accidental kill patterns
 * but can be circumvented by sufficiently creative commands.
 */
function checkHardcodedRules(command: string): PolicyResult | undefined {
  // Block ANY command that references port 3456 combined with kill-like intent.
  // The production Walnut server listens on 3456 — sessions must never restart it.
  // Catches patterns like:
  //   kill $(lsof -t -i:3456)
  //   lsof -i :3456 | head -1   (used to find PID for killing)
  //   lsof -i:3456 -P | grep LISTEN | awk '{print $2}'
  //   fuser -k 3456/tcp
  //   kill -9 <pid>  after lsof  (chained with && or |)
  //   npm run dev:prod  (script internally kills port 3456)
  //   node dist/cli.js web --port 3456  (restarts the production server)
  //   node dist/web/server.js  (starts server directly)
  const port3456Pattern = /(?:lsof\b.*\b3456|fuser\b.*\b3456|kill\b.*\b3456)/i;
  if (port3456Pattern.test(command)) {
    return {
      allowed: false,
      reason: 'Blocked: port 3456 is the production Walnut server. Use `walnut web --ephemeral` to start an isolated test server instead.',
    };
  }

  // Block npm scripts and direct commands that restart the production server.
  const serverRestartPattern = /(?:npm run (?:dev:prod|start)|node\s+dist\/(?:cli\.js\s+web|web\/server\.js))/i;
  if (serverRestartPattern.test(command)) {
    return {
      allowed: false,
      reason: 'Blocked: restarting the production Walnut server is not allowed from sessions. Use `walnut web --ephemeral` for testing.',
    };
  }

  // Block process-kill commands that target walnut by name.
  // Catches patterns like:
  //   pkill -f walnut
  //   killall walnut
  //   pkill walnut
  //   pgrep -f walnut | xargs kill
  const walnutKillPattern = /(?:pkill|killall)\b.*\bwalnut/i;
  if (walnutKillPattern.test(command)) {
    return {
      allowed: false,
      reason: 'Blocked: killing walnut processes directly is not allowed. Use `walnut web --ephemeral` for testing.',
    };
  }

  return undefined;
}

/**
 * Evaluate whether a command is permitted under the configured security policy.
 */
export function evaluateExecPolicy(
  command: string,
  config: ToolExecConfig,
): PolicyResult {
  // Hardcoded safety rules always run first
  const hardcoded = checkHardcodedRules(command);
  if (hardcoded) return hardcoded;

  const mode: ExecSecurityMode = config.security ?? 'full';
  const denyPatterns = config.deny ?? [];
  const allowPatterns = config.allow ?? [];

  // In all modes, check the deny list first
  const denyMatch = matchesAny(command, denyPatterns);
  if (denyMatch) {
    return { allowed: false, reason: `Command blocked by deny pattern: "${denyMatch}"` };
  }

  if (mode === 'allowlist') {
    const allowMatch = matchesAny(command, allowPatterns);
    if (!allowMatch) {
      return { allowed: false, reason: 'Command not in allowlist' };
    }
  }

  return { allowed: true };
}
