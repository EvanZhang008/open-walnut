/**
 * THIS machine's Claude Code: missing (one-click native install), too old for
 * the configured model (one-click update), or not signed in (the `claude`
 * instruction; the always-mounted re-check in local-claude-recheck.ts asks
 * again every 15s, and each card mount asks once at once). The server does
 * the work and pushes every step on `system:health`, so this only renders
 * what it gets. A version floor alone ('outdated') never takes a banner
 * section (localNoticeShows), the same rule as a remote host's.
 *
 * It is the FIRST section of the home attention banner (AttentionBanner): a
 * broken local Claude Code silences Walnut itself, so it sits above the remote
 * hosts. `useLocalClaudeNotice` returns the section without a frame (and its
 * title, which becomes the card title); `SetupBanner` is the framed standalone.
 * Dismissal is per state and version (host-banner-dismiss.ts), never global.
 */
import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { checkLocalClaude, fixLocalClaude } from '@/api/local-claude';
import { claudeBannerView, localNoticeShows, type ClaudeBannerView } from '@/utils/local-claude-banner';
import { clearLocalDismissed, dismissLocal, useLocalDismissed } from '@/utils/host-banner-dismiss';
import { recheckLocalClaudeNow } from '@/utils/local-claude-recheck';
import { log } from '@/utils/log';
import { firstSentence } from '@open-walnut/host-problem';
import { InlineCodeText } from './InlineCodeText';
import '@/styles/attention-banner.css';
import '@/styles/host-status.css';

/** Custom event name dispatched by NotificationPanel to re-show the banner. */
export const SETUP_SHOW_EVENT = 'setup:show-guide';

/** The install line the banner offers when `claude` is missing: the native build, which needs no Node.js. */
export const CLAUDE_CODE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

/** Kept for callers that still link the setup skill (Ask Walnut, docs). */
export const SETUP_SKILL_PASTE =
  'Set up Open Walnut for me: read and run the skill at ' +
  'https://github.com/EvanZhang008/open-walnut/blob/main/skills/setup-walnut/SKILL.md';

export const LOCAL_DISMISS_LABEL = 'Dismiss Claude Code notice';

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
  /** The local x wrote this key (the card turns the section into an undo line). */
  onDismissed?: (key: string) => void;
}

export interface LocalClaudeNotice {
  /** The section renders (the host section then gets a 'Remote hosts' subhead). */
  present: boolean;
  /** The card title: 'Get Walnut talking' / 'Update Claude Code' / 'Sign in to Claude Code'. */
  title: string | null;
  /** The section, without a card frame. */
  node: ReactNode;
  /** Which notice renders (null: none). */
  kind: 'install' | 'sign-in' | null;
}

const TITLES: Record<ClaudeBannerView['kind'], string> = {
  install: 'Get Walnut talking',
  outdated: 'Update Claude Code',
  'sign-in': 'Sign in to Claude Code',
};

const NONE: LocalClaudeNotice = { present: false, title: null, node: null, kind: null };

/** The local Claude Code section for the attention banner (no frame of its own). */
export function useLocalClaudeNotice({ health, loading, onNavigateSettings, onDismissed }: SetupBannerProps): LocalClaudeNotice {
  const dismissedList = useLocalDismissed();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The one rule the card and the bell dot share: install or sign-in, never outdated.
  const kind = localNoticeShows(health, dismissedList, loading);
  const view = kind ? claudeBannerView(health) : null;
  const dismissKey = view?.dismissKey ?? 'install:';

  const onDismiss = useCallback(() => {
    dismissLocal(dismissKey);
    onDismissed?.(dismissKey);
  }, [dismissKey, onDismissed]);

  useEffect(() => {
    window.addEventListener(SETUP_SHOW_EVENT, clearLocalDismissed);
    return () => window.removeEventListener(SETUP_SHOW_EVENT, clearLocalDismissed);
  }, []);

  // Signing in happens in a terminal: a card that mounts on the sign-in notice
  // asks once right away (the 15s interval lives in local-claude-recheck.ts).
  const signIn = kind === 'sign-in';
  const askedOnMount = useRef(false);
  useEffect(() => {
    if (!signIn || askedOnMount.current) return;
    askedOnMount.current = true;
    void recheckLocalClaudeNow();
  }, [signIn]);

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

  // Render nothing until health has actually loaded: before the first fetch
  // resolves hasReadyProvider is undefined, and treating that as "not ready" is
  // what made the onboarding flash on every refresh.
  if (!kind) return NONE;
  const title = TITLES[kind];
  const header = (
    <div className="setup-banner-header">
      <span className="setup-banner-title">{title}</span>
    </div>
  );
  // LAST in the section (Tab order: the actions, then this x; spec G20), at the end of
  // the section's last line: never in the card's top-right corner (spec 5.1, C53).
  const dismiss = (
    <button type="button" tabIndex={0} className="setup-banner-dismiss ab-local-x" onClick={onDismiss}
      aria-label={LOCAL_DISMISS_LABEL} title={LOCAL_DISMISS_LABEL}>&times;</button>
  );
  if (kind !== 'install' && view) {
    return {
      present: true, title, kind,
      node: (
        <QuietSection
          header={header}
          dismiss={dismiss}
          view={view}
          pending={pending}
          error={actionError}
          onFix={() => act(() => fixLocalClaude('claude_outdated'), 'update')}
          onCheck={() => act(() => checkLocalClaude(false), 'check')}
        />
      ),
    };
  }
  return {
    present: true, title, kind,
    node: (
      <InstallSection
        header={header}
        dismiss={dismiss}
        view={view}
        pending={pending}
        error={actionError}
        onFix={(k) => act(() => fixLocalClaude(k), 'install')}
        onNavigateSettings={onNavigateSettings}
      />
    ),
  };
}

/** The framed standalone (tests and any caller that is not the home banner). */
export function SetupBanner(props: SetupBannerProps) {
  const notice = useLocalClaudeNotice(props);
  if (!notice.present) return null;
  return <div className="setup-banner">{notice.node}</div>;
}

// ── Not ready: Claude Code is missing (that is the only thing a default install needs). ──
function InstallSection({ header, dismiss, view, pending, error, onFix, onNavigateSettings }: {
  header: ReactNode; dismiss: ReactNode; view: ClaudeBannerView | null; pending: boolean; error: string | null;
  onFix: (kind: string) => void; onNavigateSettings: (hash?: string) => void;
}) {
  const install = view?.kind === 'install' ? view : null;
  const problem = install?.problem;
  return (
    <section className="ab-local" data-testid="setup-banner-install">
      {header}
      {install?.fixable ? (
        <p className="setup-lead">
          Walnut runs on <strong>Claude Code</strong>. {problem && problem.kind !== 'claude_missing'
            ? <InlineCodeText text={problem.message} />
            : 'It is not installed on this computer yet.'}
        </p>
      ) : (
        <p className="setup-lead">
          Walnut runs on <strong>Claude Code</strong>. {problem && <><InlineCodeText text={problem.message} />{' '}</>}Install it, run <code>claude</code> once to sign in, then reload this page:
        </p>
      )}
      {install?.fixable && <FixRow view={install} label="Install Claude Code" pending={pending} error={error}
        onFix={() => onFix(problem!.kind)} />}
      {!install?.failed?.command && (
        <div className="setup-alt">
          {install?.fixable && <span className="text-sm text-muted">Or install it yourself:</span>}
          <CopyCommand command={CLAUDE_CODE_INSTALL} />
        </div>
      )}
      <div className="setup-alt ab-local-alt">
        <span className="text-sm text-muted">Prefer an API key or Bedrock credentials instead?</span>
        <button type="button" tabIndex={0} className="setup-step-btn" onClick={() => onNavigateSettings('#providers')}>
          Open API settings
        </button>
        {dismiss}
      </div>
    </section>
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
        <button type="button" tabIndex={0} className="setup-step-btn" disabled={pending} onClick={onFix} data-testid="setup-banner-fix">
          {view.failed ? 'Try again' : label}
        </button>
        {error && <span className="text-sm text-muted">{error}</span>}
      </div>
    </>
  );
}

function QuietSection({ header, dismiss, view, pending, error, onFix, onCheck }: {
  header: ReactNode; dismiss: ReactNode; view: ClaudeBannerView; pending: boolean; error: string | null;
  onFix: () => void; onCheck: () => void;
}) {
  const problem = view.problem!;
  const signIn = view.kind === 'sign-in';
  return (
    <section className="ab-local" data-testid={signIn ? 'setup-banner-sign-in' : 'setup-banner-outdated'}>
      {header}
      <LeadText message={problem.message} />
      {signIn ? (
        <>
          <CopyCommand command={problem.commands[0] ?? 'claude'} />
          <div className="setup-alt">
            <span className="text-sm text-muted">Walnut checks again every 15 seconds and hides this once you are signed in.</span>
            <button type="button" tabIndex={0} className="setup-step-btn" disabled={pending} onClick={onCheck} data-testid="setup-banner-check">Check again</button>
            {error && <span className="text-sm text-muted">{error}</span>}
            {dismiss}
          </div>
        </>
      ) : view.fixable ? (
        <FixRow view={view} label="Update Claude Code" pending={pending} error={error} onFix={onFix} />
      ) : (
        problem.commands[0] && <CopyCommand command={problem.commands[0]} />
      )}
      {!signIn && dismiss}
    </section>
  );
}

/**
 * The lead in two parts: the state ('... is not signed in.') repeats the title,
 * so a card that also lists hosts hides it (.ab-both) and keeps the fix whole
 * ('Run `claude` in a terminal and sign in.'), never a clipped sentence (N2).
 */
function LeadText({ message }: { message: string }) {
  const state = firstSentence(message).trim();
  const fix = message.slice(state.length).trim();
  if (!state || !fix) return <p className="setup-lead"><InlineCodeText text={message} /></p>;
  return (
    <p className="setup-lead">
      <span className="setup-lead-state"><InlineCodeText text={state} /> </span>
      <span className="setup-lead-fix"><InlineCodeText text={fix} /></span>
    </p>
  );
}

/** The command chip and the same text Copy / Copied button the host rows use (one copy control per card). */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard blocked, user can still select the text */ });
  }, [command]);
  const label = copied ? 'Copied' : 'Copy';
  return (
    <span className="setup-copy-wrap">
      <code className="setup-command" onClick={handleCopy} title="Click to copy">{command}</code>
      <button type="button" tabIndex={0} className="setup-copy-btn ab-copy-btn" onClick={handleCopy}
        aria-label={copied ? label : 'Copy command'} title={copied ? label : 'Copy command'}>
        {/* Copy and Copied share one width (the flip happens under the pointer). */}
        <span className="hpb-btn-stack" data-r1="Copied" data-r2="Copy"><span>{label}</span></span>
      </button>
    </span>
  );
}
