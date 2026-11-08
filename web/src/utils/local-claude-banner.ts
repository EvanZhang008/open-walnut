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
import { isLocalDismissed } from '@/utils/host-banner-dismiss';
import { AGENT_CANNOT_RUN_KINDS } from '@open-walnut/host-problem';

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

/**
 * Claude Code cannot run on this computer (missing, cannot start, or signed out): an agent
 * session cannot start here, so nothing offers "Fix with agent" (a repair session would fail
 * the same way); the setup card's install or sign-in step is the way on. Outdated still runs.
 */
export function agentCannotRun(health: SystemHealth | undefined): boolean {
  if (!health) return false;
  // The server's refusal reads the same list (routes/notifications.ts), so the button and the route agree.
  const problems = Array.isArray(health.localClaude?.problems) ? health.localClaude!.problems : [];
  return health.claudeCliAvailable === false || problems.some((p) => AGENT_CANNOT_RUN_KINDS.includes(p.kind));
}

/** What the local section can show: a Claude Code state, or (nothing needing Claude Code) the main provider not answering. */
export type LocalNoticeKind = 'install' | 'sign-in' | 'provider';

/**
 * Is the local notice a FAILURE (the red Errors badge counts it), or a setup step a new user is
 * expected to take? Claude Code not installed yet, or installed and not signed in yet, is where
 * every first run starts (2026-11-11 review: the very first open read "Errors 1" for "Claude Code
 * is not installed"): the setup card says what to do, and nothing is broken. A Claude Code that
 * cannot start, a fix that failed, or a provider that stopped answering is.
 */
export function localNoticeIsFailure(health: SystemHealth, kind: LocalNoticeKind): boolean {
  if (kind === 'provider') return true;
  const view = claudeBannerView(health);
  if (view?.failed) return true;
  return kind === 'install' && view?.problem?.kind === 'claude_error';
}

/** A dismissed "provider is not answering" stays dismissed for that provider and address only. */
export function providerDismissKey(health: Pick<SystemHealth, 'mainProvider' | 'credentialDetail'>): string {
  return `provider:${health.mainProvider ?? ''}:${health.credentialDetail ?? ''}`;
}

/** The provider line: "Ollama" for the built-in name, the configured name otherwise. */
export function providerLabel(name: string | undefined): string {
  if (!name) return 'Your AI provider';
  return name === 'ollama' ? 'Ollama' : name;
}

/**
 * Walnut asked about this machine's Claude Code and the answer settled nothing:
 * the check failed, or Claude Code is there and its sign-in is not ok with no
 * problem named (`claude auth status` gave no answer). The first-use card says
 * so, and the Sidebar keeps asking (2026-11-08: right after the one-click
 * install, under load, the first answer was "no answer"; nothing asked again,
 * so a user who then signed in stayed on "could not confirm" until a click).
 */
export function localAnswerUnsettled(health: SystemHealth | undefined): boolean {
  const local = health?.localClaude;
  if (!health || !local || health.claudeCodeNeeded === false) return false;
  return !!local.checkError || !!local.claude.unknown || (!!local.claude.found && local.claude.auth !== 'ok' && !local.problems.length);
}

/**
 * Does the local Claude Code section render right now, and as what? The one
 * rule the card and the bell dot share (so they never drift): the twin of
 * useLocalClaudeNotice's kind + hidden rules. Unknown health says nothing; no
 * provider or no CLI reads as install. 'outdated' (a model's version floor)
 * never takes a banner section, the same rule as a remote host's.
 */
export function localNoticeShows(health: SystemHealth | undefined, dismissedList: readonly string[], loading = false): LocalNoticeKind | null {
  if (!health || loading || health.hasReadyProvider === undefined) return null;
  // Nothing here runs on Claude Code (local models): its state says nothing, and
  // the one thing that can be wrong is the provider Walnut's own calls go to.
  if (health.claudeCodeNeeded === false) {
    if (health.hasReadyProvider) return null;
    return dismissedList.includes(providerDismissKey(health)) ? null : 'provider';
  }
  const view = claudeBannerView(health);
  const providerOk = health.hasReadyProvider ?? false;
  const cliOk = health.claudeCliAvailable ?? true;
  // Claude Code is fine and the model server Walnut's own calls go to is down:
  // say that, never "install Claude Code" to a machine that has it.
  if (!view && cliOk && !providerOk && health.mainProviderLocal) {
    return dismissedList.includes(providerDismissKey(health)) ? null : 'provider';
  }
  const kind = view?.kind ?? (!providerOk || !cliOk ? 'install' : null);
  if (!kind || kind === 'outdated') return null;
  return isLocalDismissed(view?.dismissKey ?? 'install:', kind, dismissedList) ? null : kind;
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
