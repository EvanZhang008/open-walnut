import { useState, useCallback, useEffect } from 'react';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { checkLocalClaude, fixLocalClaude } from '@/api/local-claude';
import { claudeBannerView, SIGN_IN_RECHECK_MS, type ClaudeBannerView } from '@/utils/local-claude-banner';
import { log } from '@/utils/log';
import { InlineCodeText } from './InlineCodeText';

const LS_DISMISS_KEY = 'walnut-setup-dismissed';
/** The outdated and sign-in states remember their own dismissal, per state and required version. */
const LS_CLAUDE_DISMISS_KEY = 'walnut-setup-dismissed-claude';

/** Custom event name dispatched by NotificationPanel to re-show the banner. */
export const SETUP_SHOW_EVENT = 'setup:show-guide';

/** The install line the banner offers when `claude` is missing: the native build, which needs no Node.js. */
export const CLAUDE_CODE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

/** Kept for callers that still link the setup skill (Ask Walnut, docs). */
export const SETUP_SKILL_PASTE =
  'Set up Open Walnut for me: read and run the skill at ' +
  'https://github.com/EvanZhang008/open-walnut/blob/main/skills/setup-walnut/SKILL.md';

interface SetupBannerProps {
  health: SystemHealth;
  /** True while the first /api/system/health fetch is in flight. The banner must
   *  render nothing until this is false: otherwise `hasReadyProvider` is undefined
   *  and we'd flash the "no provider" onboarding on every refresh before health arrives. */
  loading?: boolean;
  onNavigateSettings: (hash?: string) => void;
  /** Kept for API compatibility with the callers; the banner no longer offers a
   *  "start a session" side path, since sessions and the main agent now share one login. */
  onStartSession?: () => void;
}

const readKey = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};

/**
 * First-run and upkeep banner for THIS machine's Claude Code: missing (one-click
 * native install), too old for the configured model (one-click update), or not
 * signed in (the `claude` instruction, re-checked every 15s while it shows; it
 * goes away by itself once sign-in completes). The server does the work and
 * pushes every step on `system:health`, so the banner only renders what it gets.
 */
export function SetupBanner({ health, loading, onNavigateSettings }: SetupBannerProps) {
  const [dismissed, setDismissed] = useState(() => readKey(LS_DISMISS_KEY) === 'true');
  const [claudeDismissed, setClaudeDismissed] = useState<string | null>(() => readKey(LS_CLAUDE_DISMISS_KEY));
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const known = !loading && health.hasReadyProvider !== undefined;
  const view = known ? claudeBannerView(health) : null;
  const quiet = view && view.kind !== 'install' ? view : null;
  const quietHidden = !!quiet && claudeDismissed === quiet.dismissKey;
  const signInShowing = quiet?.kind === 'sign-in' && !quietHidden;

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem(LS_DISMISS_KEY, 'true'); } catch { /* ignore */ }
  }, []);

  const dismissClaude = useCallback((key: string) => {
    setClaudeDismissed(key);
    try { localStorage.setItem(LS_CLAUDE_DISMISS_KEY, key); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const handler = () => {
      setDismissed(false);
      setClaudeDismissed(null);
      try { localStorage.removeItem(LS_CLAUDE_DISMISS_KEY); } catch { /* ignore */ }
    };
    window.addEventListener(SETUP_SHOW_EVENT, handler);
    return () => window.removeEventListener(SETUP_SHOW_EVENT, handler);
  }, []);

  // Signing in happens in a terminal, out of Walnut's sight: ask again every 15s
  // while the banner shows. The answer arrives as a system:health push.
  useEffect(() => {
    if (!signInShowing) return;
    const timer = setInterval(() => {
      checkLocalClaude(true).catch((err) => log.warn('setup-banner', 'sign-in re-check failed', { error: String(err) }));
    }, SIGN_IN_RECHECK_MS);
    return () => clearInterval(timer);
  }, [signInShowing]);

  const act = useCallback((run: () => Promise<unknown>, what: string) => {
    setPending(true);
    setActionError(null);
    run()
      .catch((err) => {
        log.warn('setup-banner', `${what} failed`, { error: String(err) });
        setActionError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setPending(false));
  }, []);

  // Render nothing until health has actually loaded. Before the first fetch resolves,
  // hasReadyProvider is undefined; treating that as "not ready" is what made the
  // onboarding banner flash on every page refresh even when a provider was configured.
  if (!known) return null;

  const providerOk = health.hasReadyProvider ?? false;
  const cliOk = health.claudeCliAvailable ?? true;
  if (providerOk && cliOk && !view) return null;

  if (quiet) {
    if (quietHidden) return null;
    return (
      <QuietBanner
        view={quiet}
        pending={pending}
        error={actionError}
        onDismiss={() => dismissClaude(quiet.dismissKey)}
        onFix={() => act(() => fixLocalClaude('claude_outdated'), 'update')}
        onCheck={() => act(() => checkLocalClaude(false), 'check')}
      />
    );
  }
  if (dismissed) return null;

  // ── Not ready: Claude Code is missing (that is the only thing a default install needs). ──
  const install = view?.kind === 'install' ? view : null;
  const problem = install?.problem;
  return (
    <div className="setup-banner" data-testid="setup-banner-install">
      <div className="setup-banner-header">
        <span className="setup-banner-title">Get Walnut talking</span>
        <button className="setup-banner-dismiss" onClick={handleDismiss} aria-label="Dismiss setup banner">&times;</button>
      </div>
      {install?.fixable ? (
        <p className="setup-lead">
          Ask Walnut runs on <strong>Claude Code</strong>. {problem && problem.kind !== 'claude_missing'
            ? <InlineCodeText text={problem.message} />
            : 'It is not installed on this computer yet.'}
        </p>
      ) : (
        <p className="setup-lead">
          Ask Walnut runs on <strong>Claude Code</strong>. {problem && <><InlineCodeText text={problem.message} />{' '}</>}Install it, run <code>claude</code> once to sign in, then reload this page:
        </p>
      )}
      {install?.fixable && <FixRow view={install} label="Install Claude Code" pending={pending} error={actionError}
        onFix={() => act(() => fixLocalClaude(problem!.kind), 'install')} />}
      {!install?.failed?.command && (
        <div className="setup-alt">
          {install?.fixable && <span className="text-sm text-muted">Or install it yourself:</span>}
          <CopyCommand command={CLAUDE_CODE_INSTALL} />
        </div>
      )}
      <div className="setup-alt" style={{ marginTop: 10 }}>
        <span className="text-sm text-muted">Prefer an API key or Bedrock credentials instead?</span>
        <button className="setup-step-btn" onClick={() => onNavigateSettings('#providers')}>
          Open API settings
        </button>
      </div>
    </div>
  );
}

/** The one-click fix: its button, "Installing Claude Code...", or why it failed with the command to run. */
function FixRow({ view, label, pending, error, onFix }: {
  view: ClaudeBannerView; label: string; pending: boolean; error: string | null; onFix: () => void;
}) {
  if (view.running) return <p className="setup-lead" data-testid="setup-banner-fixing">{view.running}...</p>;
  return (
    <>
      {view.failed && (
        <p className="setup-lead" data-testid="setup-banner-fix-failed">
          {view.failed.text}{view.failed.command ? ': run it yourself' : '.'}
        </p>
      )}
      {view.failed?.command && <CopyCommand command={view.failed.command} />}
      <div className="setup-alt">
        <button className="setup-step-btn" disabled={pending} onClick={onFix} data-testid="setup-banner-fix">
          {view.failed ? 'Try again' : label}
        </button>
        {error && <span className="text-sm text-muted">{error}</span>}
      </div>
    </>
  );
}

function QuietBanner({ view, pending, error, onDismiss, onFix, onCheck }: {
  view: ClaudeBannerView; pending: boolean; error: string | null;
  onDismiss: () => void; onFix: () => void; onCheck: () => void;
}) {
  const problem = view.problem!;
  const signIn = view.kind === 'sign-in';
  return (
    <div className="setup-banner" data-testid={signIn ? 'setup-banner-sign-in' : 'setup-banner-outdated'}>
      <div className="setup-banner-header">
        <span className="setup-banner-title">{signIn ? 'Sign in to Claude Code' : 'Update Claude Code'}</span>
        <button className="setup-banner-dismiss" onClick={onDismiss} aria-label="Dismiss setup banner">&times;</button>
      </div>
      <p className="setup-lead"><InlineCodeText text={problem.message} /></p>
      {signIn ? (
        <>
          <CopyCommand command={problem.commands[0] ?? 'claude'} />
          <div className="setup-alt">
            <span className="text-sm text-muted">Walnut checks again every 15 seconds and hides this once you are signed in.</span>
            <button className="setup-step-btn" disabled={pending} onClick={onCheck} data-testid="setup-banner-check">Check now</button>
            {error && <span className="text-sm text-muted">{error}</span>}
          </div>
        </>
      ) : view.fixable ? (
        <FixRow view={view} label="Update Claude Code" pending={pending} error={error} onFix={onFix} />
      ) : (
        problem.commands[0] && <CopyCommand command={problem.commands[0]} />
      )}
    </div>
  );
}

function CopyCommand({ command, multiline }: { command: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard blocked, user can still select the text */ });
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
