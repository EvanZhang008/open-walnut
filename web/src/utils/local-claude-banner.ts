/**
 * Which Claude Code state the setup banner shows for THIS machine, read off
 * /api/system/health (`claudeCliAvailable` + `localClaude`). Three states, in
 * the order they block Walnut:
 *   install  Claude Code is missing (or cannot start): one-click native install
 *   outdated older than the configured model needs: one-click update
 *   sign-in  installed but not signed in: the `claude` instruction, re-checked
 *            every 15s while the banner is open
 * Pure, so the rules are unit-tested without rendering.
 */
import type { SystemHealth } from '@/hooks/useSystemHealth';
import type { LocalClaudeProblem } from '@/api/local-claude';

export type ClaudeBannerKind = 'install' | 'outdated' | 'sign-in';

export interface ClaudeBannerView {
  kind: ClaudeBannerKind;
  /** The server's line; absent for an install state known only from `claudeCliAvailable`. */
  problem?: LocalClaudeProblem;
  /** The server can run the fix for it (the button shows). */
  fixable: boolean;
  /** The fix is running: "Installing Claude Code". */
  running?: string;
  /** The last attempt failed: its reason, and the command to run by hand. */
  failed?: { text: string; command?: string };
  /** Dismissing is remembered per state and version (host-banner-dismiss.ts localDismissKey), so a new problem shows again. */
  dismissKey: string;
}

/** The banner re-asks the server this often while it shows the sign-in state. */
export const SIGN_IN_RECHECK_MS = 15_000;

const INSTALL_KINDS = ['claude_missing', 'claude_needs_node', 'claude_error'];
/** Mirrors fixActionFor (src/core/hosts/host-autofix.ts): what the server will run. */
const FIXABLE_INSTALL = new Set(['claude_missing', 'claude_needs_node']);

function withFix(problem: LocalClaudeProblem | undefined): Pick<ClaudeBannerView, 'running' | 'failed'> {
  const fix = problem?.fix;
  if (fix?.state === 'running') return { running: fix.text };
  if (fix?.state === 'failed') return { failed: { text: fix.text, ...(problem?.commands[0] ? { command: problem.commands[0] } : {}) } };
  return {};
}

export function claudeBannerView(health: SystemHealth): ClaudeBannerView | null {
  const local = health.localClaude;
  const problems = Array.isArray(local?.problems) ? local!.problems : [];
  const install = problems.find((p) => INSTALL_KINDS.includes(p.kind));
  if (install || health.claudeCliAvailable === false) {
    return {
      kind: 'install',
      ...(install ? { problem: install } : {}),
      fixable: !!install && FIXABLE_INSTALL.has(install.kind),
      ...withFix(install),
      dismissKey: `install:${local?.claude?.minVersion ?? ''}`,
    };
  }
  const outdated = problems.find((p) => p.kind === 'claude_outdated');
  if (outdated) {
    const method = local?.claude.installMethod ?? (local?.claude.kind === 'npm' ? 'npm' : undefined);
    return {
      kind: 'outdated',
      problem: outdated,
      fixable: method === 'native' || method === 'npm',
      ...withFix(outdated),
      dismissKey: `outdated:${local?.claude.minVersion ?? ''}`,
    };
  }
  const signIn = problems.find((p) => p.kind === 'claude_not_logged_in');
  if (signIn) return { kind: 'sign-in', problem: signIn, fixable: false, dismissKey: `sign-in:${local?.claude.version ?? ''}` };
  return null;
}

/** "Run `claude` once" → text and code runs, for rendering a server line. */
export function splitInlineCode(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const parts = text.split('`');
  // An odd count of backticks leaves the tail unclosed: show it as plain text.
  const closed = parts.length % 2 === 1;
  parts.forEach((part, i) => {
    if (!part) return;
    const code = i % 2 === 1 && (closed || i < parts.length - 1);
    out.push({ code, text: code ? part : (i % 2 === 1 ? '`' + part : part) });
  });
  return out;
}
