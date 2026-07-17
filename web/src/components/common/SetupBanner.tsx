/**
 * SetupBanner — first-run onboarding shown in the chat area until the butler
 * has a working AI provider. It routes between THREE paths to a credential:
 *
 *   1. Auto-detect  — when Walnut already resolved a credential from a non-config
 *      source (env / ~/.claude/settings.json / ~/.aws), show a small dismissible
 *      "Auto-detected via <source>" confirmation instead of the full checklist.
 *   2. Hero (paste)  — a one-click copy block the user pastes into their OWN
 *      already-authenticated Claude Code; the setup-walnut skill mirrors the exact
 *      working credential into Walnut, installs deps, and starts the server.
 *   3. Manual        — jump to Settings → AI Provider (the existing Bedrock form
 *      with bearer-token / access-keys / profile + live Test Connection).
 *
 * Dismissible via localStorage; re-accessible from NotificationPanel.
 */
import { useState, useCallback, useEffect } from 'react';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { InstallButton } from './InstallButton';

const LS_DISMISS_KEY = 'walnut-setup-dismissed';
/** Separate key so dismissing the small "auto-detected" note doesn't hide the real checklist later. */
const LS_AUTODETECT_DISMISS_KEY = 'walnut-setup-autodetect-dismissed';

/** Custom event name dispatched by NotificationPanel to re-show the banner. */
export const SETUP_SHOW_EVENT = 'setup:show-guide';

/** The exact line the user pastes into their own Claude Code session (path 2, the hero).
 *  The skill is proactive: it mirrors however the user's Claude Code is already
 *  authenticated into Walnut, then verifies with a real model call. */
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
  // The butler's ready via a logged-in Claude Code subscription — resolveCredentialHealth()
  // tags this `source:'config'` (it's not a Bedrock/API-key ladder hit) with a detail
  // string prefix, so it needs its own check rather than the source !== 'config' test below.
  const viaSubscription = providerOk && source === 'config' && !!health.credentialDetail?.startsWith('claude-cli');

  // ── Path 1: auto-detected. Provider is ready from a NON-config source (or from the
  //    subscription) → show a small confirmation note (transparent + overridable),
  //    not the full checklist. ──
  const autoDetected = providerOk && ((!!source && source !== 'config' && source !== 'none') || viaSubscription);
  if (autoDetected) {
    if (autoNoteDismissed) return null;
    return (
      <div className="setup-banner setup-banner-autodetect">
        <div className="setup-banner-header">
          <span className="setup-banner-title">
            {viaSubscription
              ? <>{'✓'} Using your Claude Code subscription</>
              : <>{'✓'} Auto-detected Bedrock via {SOURCE_LABELS[source!] ?? source}</>}
          </span>
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

  // Provider ready from config (explicit) and CLI present → fully set up, nothing to show.
  if (providerOk && cliOk) return null;
  if (dismissed) return null;

  // ── Provider NOT ready → full onboarding with the three paths. ──
  return (
    <div className="setup-banner">
      <div className="setup-banner-header">
        <span className="setup-banner-title">Get Walnut talking</span>
        <button className="setup-banner-dismiss" onClick={handleDismiss} aria-label="Dismiss setup banner">&times;</button>
      </div>

      {!providerOk && (
        <>
          {/* Path 2 — the hero: paste into your own Claude Code */}
          <div className="setup-hero">
            <div className="setup-hero-label">
              <span className="setup-hero-badge">Fastest</span>
              Already using Claude Code? Paste this into it — it mirrors how your Claude Code
              is authenticated into Walnut, installs and starts everything, and verifies it
              with a real model call:
            </div>
            <CopyCommand command={SETUP_SKILL_PASTE} multiline />
          </div>

          {/* Path 3 — manual */}
          <div className="setup-alt">
            <span className="text-sm text-muted">Or configure a provider yourself:</span>
            <button className="setup-step-btn" onClick={() => onNavigateSettings('#providers')}>
              Settings &rarr; AI Provider
            </button>
          </div>
        </>
      )}

      {/* CLI install — optional, only powers coding sessions (the butler doesn't need it). */}
      {!cliOk && (
        <div className="setup-banner-steps" style={{ marginTop: 10 }}>
          <SetupStep done={false} label="Install Claude Code CLI (for coding sessions)" required={false}>
            <InstallButton target="claude-cli" />
            <CopyCommand command="npm install -g @anthropic-ai/claude-code" />
          </SetupStep>
        </div>
      )}
    </div>
  );
}

function SetupStep({ done, label, required, children }: {
  done: boolean;
  label: string;
  required: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`setup-step ${done ? 'done' : 'pending'}`}>
      <span className="setup-step-icon">{done ? '✓' : '○'}</span>
      <div className="setup-step-content">
        <span className="setup-step-label">
          {label}
          {!required && <span className="setup-step-optional">optional</span>}
        </span>
        {!done && <div className="setup-step-action">{children}</div>}
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
