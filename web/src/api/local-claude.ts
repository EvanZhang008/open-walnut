/**
 * This machine's Claude Code, as the setup banner reads it: the server's
 * `localClaude` on /api/system/health (src/core/hosts/local-readiness.ts), plus
 * the two actions the banner offers. Every field is optional on the wire: an
 * older server sends no `localClaude`, and that reads as "nothing to say".
 */
import { apiPost } from './client';

export interface LocalClaudeProblem {
  /** claude_missing | claude_needs_node | claude_error | claude_outdated | claude_not_logged_in */
  kind: string;
  /** One sentence; a command inside it is in `backticks`. */
  message: string;
  commands: string[];
  fix?: { action: string; state: 'running' | 'failed'; text: string; detail?: string };
}

export interface LocalClaudeStatus {
  checkedAt: number;
  claude: {
    found: boolean;
    version?: string;
    kind?: string;
    auth?: 'ok' | 'not-logged-in' | 'unknown';
    authDetail?: string;
    versionOk?: boolean;
    minVersion?: string;
    installMethod?: 'native' | 'npm' | 'homebrew' | 'other';
  };
  problems: LocalClaudeProblem[];
  checkError?: string;
  fixing?: { action: string; startedAt: number; text: string };
  lastFix?: { action: string; ok: boolean; text: string; command?: string; ageMs: number };
}

/** Ask the server to look at this machine again. `poll` = the banner's timer (may be answered from a fresh result). */
export function checkLocalClaude(poll = false): Promise<{ localClaude: LocalClaudeStatus | null }> {
  return apiPost('/api/system/local-claude/check', { poll }, { timeoutMs: 20_000, background: poll });
}

/** Start the one-click install or update for one problem. 409 = nothing to run (answered quietly). */
export function fixLocalClaude(kind: string): Promise<{ localClaude: LocalClaudeStatus | null }> {
  return apiPost('/api/system/local-claude/fix', { kind }, { timeoutMs: 20_000, quietStatuses: [409] });
}
