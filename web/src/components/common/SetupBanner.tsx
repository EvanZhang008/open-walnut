/**
 * SetupBanner — the first-run note in the chat area.
 *
 * Walnut runs on Claude Code: the main chat is a `claude` session and, by default,
 * so is every background call. So there is exactly one thing a new machine can be
 * missing, the `claude` binary, and the banner says only that:
 *
 *   - Claude Code found  → one dismissible line naming what it signs in with
 *     ("Bedrock (us-west-2)", "your Claude subscription"), with a link to change it.
 *   - Claude Code missing → the install command, plus a small link for people who
 *     would rather point Walnut at an API key or Bedrock directly.
 *   - Another provider configured and ready → the existing "auto-detected" note, or
 *     nothing when it came from saved configuration.
 *
 * Dismissible via localStorage; re-accessible from NotificationPanel.
 */
import { useState, useCallback, useEffect } from 'react';
import type { SystemHealth } from '@/hooks/useSystemHealth';

const LS_DISMISS_KEY = 'walnut-setup-dismissed';
/** Separate key so dismissing the small "ready" note doesn't hide the real checklist later. */
const LS_AUTODETECT_DISMISS_KEY = 'walnut-setup-autodetect-dismissed';

/** Custom event name dispatched by NotificationPanel to re-show the banner. */
export const SETUP_SHOW_EVENT = 'setup:show-guide';

/** The install line the banner offers when `claude` is missing. */
export const CLAUDE_CODE_INSTALL = 'npm install -g @anthropic-ai/claude-code';

/** Kept for callers that still link the setup skill (Ask Walnut, docs). */
export const SETUP_SKILL_PASTE =
  'Set up Open Walnut for me: read and run the skill at ' +
  'https://github.com/EvanZhang008/open-walnut/blob/main/skills/setup-walnut/SKILL.md';

/** Human label for each credential source. */
const SOURCE_LABELS: Record<string, string> = {
  config: 'saved configuration',
  'claude-settings': '~/.claude/settings.json',
  env: 'environment variables',
  'aws-files': '~/.aws credentials',
};

interface SetupBannerProps {
  health: SystemHealth;
  /** True while the first /api/system/health fetch is in flight. The banner must
   *  render nothing until this is false — otherwise `hasReadyProvider` is undefined
   *  and we'd flash the "no provider" onboarding on every refresh before health arrives. */
  loading?: boolean;
  onNavigateSettings: (hash?: string) => void;
  /** Kept for API compatibility with the callers; the banner no longer offers a
   *  "start a session" side path, since sessions and the main agent now share one login. */
  onStartSession?: () => void;
}

export function SetupBanner({ health, loading, onNavigateSettings }: SetupBannerProps) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(LS_DISMISS_KEY) === 'true'; } catch { return false; }
  });
  const [autoNoteDismissed, setAutoNoteDismissed] = useState(() => {
    try { return localStorage.getItem(LS_AUTODETECT_DISMISS_KEY) === 'true'; } catch { return false; }
  });

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem(LS_DISMISS_KEY, 'true'); } catch { /* ignore */ }
  }, []);

  const handleAutoNoteDismiss = useCallback(() => {
    setAutoNoteDismissed(true);
    try { localStorage.setItem(LS_AUTODETECT_DISMISS_KEY, 'true'); } catch { /* ignore */ }
  }, []);

  // Listen for "Show Setup Guide" from NotificationPanel — clears both dismiss flags.
  useEffect(() => {
    const handler = () => { setDismissed(false); setAutoNoteDismissed(false); };
    window.addEventListener(SETUP_SHOW_EVENT, handler);
    return () => window.removeEventListener(SETUP_SHOW_EVENT, handler);
  }, []);

  // Render nothing until health has actually loaded. Before the first fetch resolves,
  // hasReadyProvider is undefined; treating that as "not ready" is what made the
  // onboarding banner flash on every page refresh even when a provider was configured.
  if (loading || health.hasReadyProvider === undefined) return null;

  const providerOk = health.hasReadyProvider ?? false;
  const cliOk = health.claudeCliAvailable ?? true;
  const source = health.credentialSource;
  const viaClaudeCode = providerOk && (health.mainProvider === 'claude_cli' || !!health.credentialDetail?.startsWith('claude-cli'));

  // ── Ready on Claude Code: one line, dismissible. ──
  if (viaClaudeCode) {
    if (autoNoteDismissed) return null;
    return (
      <div className="setup-banner setup-banner-autodetect" data-testid="setup-banner-claude-code">
        <div className="setup-banner-header">
          <span className="setup-banner-title">{'✓'} Walnut runs on your Claude Code</span>
          <button className="setup-banner-dismiss" onClick={handleAutoNoteDismiss} aria-label="Dismiss">&times;</button>
        </div>
        <p className="text-sm text-muted" style={{ margin: 0 }}>
          Ask Walnut, your coding sessions, and the background helpers all use the <code>claude</code> you already have
          {health.claudeCliAuth ? <>, signed in with {health.claudeCliAuth}</> : null}. Nothing to configure.
          {' '}
          <button className="setup-link-btn" onClick={() => onNavigateSettings('#providers')}>Use a different provider</button>
        </p>
      </div>
    );
  }

  // ── Ready on something else that Walnut found for itself (env / settings.json / ~/.aws). ──
  const autoDetected = providerOk && !!source && source !== 'config' && source !== 'none';
  if (autoDetected) {
    if (autoNoteDismissed) return null;
    return (
      <div className="setup-banner setup-banner-autodetect">
        <div className="setup-banner-header">
          <span className="setup-banner-title">{'✓'} Auto-detected Bedrock via {SOURCE_LABELS[source!] ?? source}</span>
          <button className="setup-banner-dismiss" onClick={handleAutoNoteDismiss} aria-label="Dismiss">&times;</button>
        </div>
        <p className="text-sm text-muted" style={{ margin: 0 }}>
          Walnut is using {health.credentialDetail ? <code style={{ fontSize: 11 }}>{health.credentialDetail}</code> : 'detected credentials'}.
          {' '}
          <button className="setup-link-btn" onClick={() => onNavigateSettings('#providers')}>Change provider</button>
        </p>
      </div>
    );
  }

  // Ready from saved configuration and the CLI is present → fully set up, nothing to show.
  if (providerOk && cliOk) return null;
  if (dismissed) return null;

  // ── Not ready: Claude Code is missing (that is the only thing a default install needs). ──
  return (
    <div className="setup-banner" data-testid="setup-banner-install">
      <div className="setup-banner-header">
        <span className="setup-banner-title">Get Walnut talking</span>
        <button className="setup-banner-dismiss" onClick={handleDismiss} aria-label="Dismiss setup banner">&times;</button>
      </div>
      <p className="setup-lead">
        Ask Walnut runs on <strong>Claude Code</strong>. Install it, run <code>claude</code> once to sign in, then reload this page:
      </p>
      <CopyCommand command={CLAUDE_CODE_INSTALL} />
      <div className="setup-alt" style={{ marginTop: 10 }}>
        <span className="text-sm text-muted">Prefer an API key or Bedrock credentials instead?</span>
        <button className="setup-step-btn" onClick={() => onNavigateSettings('#providers')}>
          Settings &rarr; Ask Walnut Provider
        </button>
      </div>
    </div>
  );
}

function CopyCommand({ command, multiline }: { command: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard blocked — user can still select the text */ });
  }, [command]);

  return (
    <span className={`setup-copy-wrap${multiline ? ' setup-copy-wrap-multiline' : ''}`}>
      <code className={`setup-command${multiline ? ' setup-command-multiline' : ''}`} onClick={handleCopy} title="Click to copy">{command}</code>
      <button className="setup-copy-btn" onClick={handleCopy} aria-label="Copy command">
        {copied ? '✓' : '⎘'}
      </button>
    </span>
  );
}

/** Exported so NotificationPanel can clear the dismiss key. */
export const SETUP_DISMISS_KEY = LS_DISMISS_KEY;
