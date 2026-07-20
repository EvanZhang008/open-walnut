/**
 * error-suggestions.ts — Maps error messages to actionable suggestions with Settings deep-links.
 *
 * Source-aware: session errors never suggest Ollama fixes; embedding errors never suggest CLI fixes.
 * Each rule is domain-appropriate based on the ErrorContext passed by the caller.
 */

export interface ErrorSuggestion {
  suggestion: string;
  /** Settings hash fragment: 'providers' | 'search' | 'sessions' | 'remote-hosts' | 'integrations' */
  settingsHash?: string;
  /** Human label for the settings link, e.g. "AI Provider" */
  settingsLabel?: string;
  /** If set, renders an inline button that copies the install command. */
  installTarget?: 'claude-cli' | 'ollama';
}

export interface ErrorContext {
  /** Truthy = remote session */
  host?: string;
  /** 'cli' | 'sdk' | 'embedded' */
  provider?: string;
  /** Explicit domain hint — prevents cross-domain mismatches */
  domain?: 'session' | 'embedding' | 'git';
}

interface Rule {
  pattern: RegExp;
  /** Optional guard: return false to skip this rule even if pattern matches */
  guard?: (ctx: ErrorContext) => boolean;
  suggestion: ErrorSuggestion;
}

const RULES: Rule[] = [
  // --- Credential / provider errors (session domain) ---
  {
    pattern: /credential|Could not load credentials|UnrecognizedClientException|unauthorized|api.?key.*not found/i,
    suggestion: {
      suggestion: 'Check your AI provider credentials.',
      settingsHash: 'providers',
      settingsLabel: 'AI Provider',
    },
  },

  // --- CLI not found (local) ---
  {
    pattern: /Failed to spawn|CLI binary was not found|command not found.*claude|ENOENT.*claude/i,
    guard: (ctx) => !ctx.host,
    suggestion: {
      suggestion: 'Install the Claude Code CLI.',
      settingsHash: 'sessions',
      settingsLabel: 'Sessions',
      installTarget: 'claude-cli',
    },
  },

  // --- CLI not found (remote) ---
  {
    pattern: /Claude CLI not found on remote|exit.*code 127/i,
    suggestion: {
      suggestion: 'Install Claude Code CLI on the remote host.',
      settingsHash: 'remote-hosts',
      settingsLabel: 'Remote Hosts',
    },
  },
  // Failed to spawn on a remote host
  {
    pattern: /Failed to spawn/i,
    guard: (ctx) => !!ctx.host,
    suggestion: {
      suggestion: 'Install Claude Code CLI on the remote host.',
      settingsHash: 'remote-hosts',
      settingsLabel: 'Remote Hosts',
    },
  },

  // --- SSH / remote connection ---
  {
    pattern: /Connection lost|ssh.*fail|ssh.*refuse|WebSocket connection failed|deploy.*failed|daemon.*failed|tunnel.*not accepting/i,
    suggestion: {
      suggestion: 'Check remote host connectivity and SSH credentials.',
      settingsHash: 'remote-hosts',
      settingsLabel: 'Remote Hosts',
    },
  },

  // --- Remote session exit (generic) ---
  {
    pattern: /Remote session exited with code/i,
    suggestion: {
      suggestion: 'Check remote host configuration.',
      settingsHash: 'remote-hosts',
      settingsLabel: 'Remote Hosts',
    },
  },

  // --- Idle timeout ---
  {
    pattern: /No output for.*min/i,
    suggestion: {
      suggestion: 'Adjust the idle timeout in session settings.',
      settingsHash: 'sessions',
      settingsLabel: 'Sessions',
    },
  },

  // --- Ollama / embedding ---
  {
    pattern: /ollama.*unavail|ollama.*not.*detect|ECONNREFUSED.*11434|Ollama embed failed|Model.*not found.*ollama pull/i,
    suggestion: {
      suggestion: 'Install and start Ollama for semantic search.',
      settingsHash: 'search',
      settingsLabel: 'Search',
      installTarget: 'ollama',
    },
  },
];

/**
 * Match an error message to an actionable suggestion.
 * Returns null when no rule matches — callers should render nothing (graceful degradation).
 */
export function getErrorSuggestion(errorText: string, ctx?: ErrorContext): ErrorSuggestion | null {
  const c = ctx ?? {};

  // Git domain: always return git suggestion regardless of error text
  if (c.domain === 'git') {
    return {
      suggestion: 'Configure git backup for data protection.',
      settingsHash: 'integrations',
      settingsLabel: 'Integrations',
    };
  }

  for (const rule of RULES) {
    if (!rule.pattern.test(errorText)) continue;
    if (rule.guard && !rule.guard(c)) continue;
    return rule.suggestion;
  }

  return null;
}
