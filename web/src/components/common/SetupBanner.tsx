/**
 * THIS machine's Claude Code: missing (one-click native install), too old for
 * the configured model (one-click update), or not signed in (the `claude`
 * instruction; the always-mounted re-check in local-claude-recheck.ts asks
 * again every 15s, and each card mount asks once at once). The server does
 * the work and pushes every step on `system:health`, so this only renders
 * what it gets. A version floor alone ('outdated') never takes a banner
 * section (localNoticeShows), the same rule as a remote host's.
 *
 * It leads the notification panel's problem rows (NotificationProblems): a
 * broken local Claude Code silences Walnut itself, so it sits above the remote
 * hosts. `useLocalClaudeNotice` returns the section without a frame (and its
 * title, a one-line summary and its x, which the panel's notice card puts at
 * its top right like every card's); `SetupBanner` is the framed standalone
 * (the first-use card). Dismissal is per state and version
 * (host-banner-dismiss.ts), never global.
 *
 * In the panel (not first use) a section has one main action (Install Claude
 * Code), API settings as its second, and the rest (the command to run by hand,
 * API credentials) folded under "Other ways to set up" (2026-11-21 audit: two
 * outlined blue buttons of one weight, the command broken at its pipe so it read
 * as two, and the x at the bottom). Its buttons are the card family's
 * (`.ask-card-answer .btn`, components/actions/ask-card.css).
 */
import { CopyButton } from './CopyButton';
import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { checkLocalClaude, fixLocalClaude } from '@/api/local-claude';
import { claudeBannerView, localNoticeShows, providerDismissKey, providerLabel, type ClaudeBannerView, type LocalNoticeKind } from '@/utils/local-claude-banner';
import { clearLocalDismissed, dismissLocal, useLocalDismissed } from '@/utils/host-banner-dismiss';
import { recheckLocalClaudeNow } from '@/utils/local-claude-recheck';
import { log } from '@/utils/log';
import { firstSentence } from '@open-walnut/host-problem';
import { InlineCodeText } from './InlineCodeText';
import { useDetailsDisclosure } from '@/components/sessions/row-disclosure';
import { HostFixButton } from './HostFixButton';
import { SetupProgress } from './SetupProgress';
import { canOpenClaudeSignIn, openClaudeSignIn } from '@/utils/claude-sign-in';
import { demoSignInCopy, DEMO_SIGN_IN_UNAVAILABLE } from '@/utils/demo-generation';
import '@/styles/attention-banner.css';
import '@/styles/host-status.css';
import '@/components/actions/ask-card.css';

/** Custom event name dispatched by NotificationPanel to re-show the banner. */
export const SETUP_SHOW_EVENT = 'setup:show-guide';

/** The install line the banner offers when `claude` is missing: the native build, which needs no Node.js. */
export const CLAUDE_CODE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

/** Kept for callers that still link the setup skill (Ask Walnut, docs). */
export const SETUP_SKILL_PASTE =
  'Set up Open Walnut for me: read and run the skill at ' +
  'https://github.com/EvanZhang008/open-walnut/blob/main/skills/setup-walnut/SKILL.md';

// A copied command runs in the user's own terminal, so on Demo it would sign in or install into the real home.
export { DEMO_SIGN_IN_UNAVAILABLE };
export const DEMO_SIGN_IN_LEAD = 'Claude Code is not signed in to Walnut Demo. Run the command below in a terminal; it signs in Walnut Demo only, never your own Claude Code.';

export const DEMO_INSTALL_ONE_CLICK = 'Use Install Claude Code below; Walnut Demo installs it into its own home, not yours.';
export const DEMO_UPDATE_ONE_CLICK = 'Use Update Claude Code below; Walnut Demo updates its own copy, not yours.';
export const DEMO_UPDATE_UNAVAILABLE = 'Walnut Demo cannot update Claude Code here by itself, and has no safe command for your terminal. Use another provider in API settings, or reload Walnut Demo once Claude Code is updated.';
export const DEMO_INSTALL_UNAVAILABLE = 'Walnut Demo cannot install Claude Code here by itself, so it shows no install command: one run in your terminal would install into your real home, not Walnut Demo. Use another provider in API settings, or reload Walnut Demo once Claude Code is on this computer.';

export const LOCAL_DISMISS_LABEL = 'Dismiss Claude Code notice';
export const PROVIDER_DISMISS_LABEL = 'Dismiss AI provider notice';

interface SetupBannerProps {
  health: SystemHealth;
  firstUse?: boolean;
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
  onRepairNavigate?: (to: string) => void;
}

export interface LocalClaudeNotice {
  /** The section renders (the host section then gets a 'Remote hosts' subhead). */
  present: boolean;
  /** The card title: 'Get Walnut talking' / 'Update Claude Code' / 'Sign in to Claude Code'. */
  title: string | null;
  /** The state in one sentence, for a card that shows only its head. */
  summary: string | null;
  /** The section, without a card frame and without its x. */
  node: ReactNode;
  /** The section's x (named for what it hides); the card that frames it places it. */
  dismiss: ReactNode;
  /** Which notice renders (null: none). */
  kind: LocalNoticeKind | ClaudeBannerView['kind'] | null;
}

const TITLES: Record<ClaudeBannerView['kind'], string> = {
  install: 'Get Walnut talking',
  outdated: 'Update Claude Code',
  'sign-in': 'Sign in to Claude Code',
};

const NONE: LocalClaudeNotice = { present: false, title: null, summary: null, node: null, dismiss: null, kind: null };

/** The state in one sentence (the server's first, when it named one). */
function summaryOf(kind: LocalNoticeKind | ClaudeBannerView['kind'], view: ClaudeBannerView | null, health: SystemHealth): string {
  if (kind === 'provider') {
    const name = providerLabel(health.mainProvider);
    return health.mainProviderLocal ? `${name} is not answering.` : `${name} has no key or sign-in yet.`;
  }
  const message = view?.problem?.message;
  if (message) return firstSentence(message).trim();
  return kind === 'sign-in' ? 'Claude Code is not signed in.' : 'Claude Code is not installed on this computer.';
}

/** The local Claude Code section for the attention banner (no frame of its own). */
export function useLocalClaudeNotice({ health, loading, firstUse, onNavigateSettings, onDismissed, onRepairNavigate }: SetupBannerProps): LocalClaudeNotice {
  const dismissedList = useLocalDismissed();
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const firstView = firstUse && !loading && health.claudeCodeNeeded !== false ? claudeBannerView(health) : null;
  const kind = firstView?.kind ?? localNoticeShows(health, firstUse ? [] : dismissedList, loading);
  const view = kind && kind !== 'provider' ? claudeBannerView(health) : null;
  const dismissKey = kind === 'provider' ? providerDismissKey(health) : view?.dismissKey ?? 'install:';

  const onDismiss = useCallback(() => {
    dismissLocal(dismissKey);
    onDismissed?.(dismissKey);
  }, [dismissKey, onDismissed]);

  useEffect(() => {
    window.addEventListener(SETUP_SHOW_EVENT, clearLocalDismissed);
    return () => window.removeEventListener(SETUP_SHOW_EVENT, clearLocalDismissed);
  }, []);

  // Signing in, installing or updating by hand happen in a terminal: a card that
  // mounts on one of those notices asks once right away, unless Walnut's own fix
  // runs (the 15s interval lives in local-claude-recheck.ts).
  const terminalCanClear = (kind === 'sign-in' || kind === 'install' || kind === 'outdated') && !view?.running;
  const askedOnMount = useRef(false);
  useEffect(() => {
    if (!terminalCanClear || askedOnMount.current) return;
    askedOnMount.current = true;
    void recheckLocalClaudeNow();
  }, [terminalCanClear]);

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
  const title = kind === 'provider' ? TITLES.install : TITLES[kind];
  const header = (
    <div className="setup-banner-header">
      <span className="setup-banner-title">{title}</span>
    </div>
  );
  // At the card's top right, like every notice's x (2026-11-21 audit; it used to end the
  // section's last line). The first-use install card has none: it is the page.
  const dismissLabel = kind === 'provider' ? PROVIDER_DISMISS_LABEL : LOCAL_DISMISS_LABEL;
  const dismiss = firstUse && kind === 'install' ? null : (
    <button type="button" tabIndex={0} className="setup-banner-dismiss ab-local-x wn-notice-x" onClick={onDismiss}
      aria-label={dismissLabel} title={dismissLabel}>&times;</button>
  );
  const summary = summaryOf(kind, view, health);
  if (kind === 'provider') {
    return {
      present: true, title, summary, kind, dismiss,
      node: <ProviderSection header={header} panel={!firstUse} health={health} onNavigateSettings={onNavigateSettings} />,
    };
  }
  if (kind !== 'install' && view) {
    return {
      present: true, title, summary, kind, dismiss,
      node: (
        <QuietSection
          header={header}
          onRepairNavigate={onRepairNavigate}
          firstUse={firstUse}
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
    present: true, title, summary, kind, dismiss,
    node: (
      <InstallSection
        header={header}
        onRepairNavigate={onRepairNavigate}
        firstUse={firstUse}
        view={view}
        pending={pending}
        error={actionError}
        onFix={(k) => act(() => fixLocalClaude(k), 'install')}
        onNavigateSettings={onNavigateSettings}
      />
    ),
  };
}

/** The framed standalone (tests and any caller that is not the home banner): its x at its top right. */
export function SetupBanner(props: SetupBannerProps) {
  const notice = useLocalClaudeNotice(props);
  if (!notice.present) return null;
  return <div className="setup-banner">{notice.dismiss && <span className="setup-banner-x">{notice.dismiss}</span>}{notice.node}</div>;
}

// ── Not ready: Claude Code is missing (that is the only thing a default install needs). ──
function InstallSection({ header, view, pending, error, onFix, onNavigateSettings, onRepairNavigate, firstUse }: {
  header: ReactNode; view: ClaudeBannerView | null; pending: boolean; error: string | null;
  onFix: (kind: string) => void; onNavigateSettings: (hash?: string) => void; onRepairNavigate?: (to: string) => void; firstUse?: boolean;
}) {
  const install = view?.kind === 'install' ? view : null;
  const problem = install?.problem;
  const demo = onDemo();
  const panel = !firstUse;
  // On the section's action line, never a line of its own (2026-10-31: BP-R4-N3-3).
  const repair = panel && <HostFixButton target={{ host: '__local__' }} name="this computer" onNavigate={onRepairNavigate} />;
  // Kept like a chat row's details (this file is drawn inside chat rows too, AgentWaitNote):
  // outside a session's rows it is plain local state.
  const alternatives = useDetailsDisclosure('setup-first-use-alternatives');
  const otherWays = useDetailsDisclosure('setup-panel-other-ways');
  const apiSettings = (
    <button type="button" tabIndex={0} className="btn btn-sm" onClick={() => onNavigateSettings('#providers')}>Open API settings</button>
  );
  // The command is the way on when Walnut cannot run the install itself; else it is one of the other ways.
  const manualIsMain = !install?.fixable && !demo && !install?.failed?.command;
  return (
    <section className="ab-local" data-testid="setup-banner-install">
      {header}
      {install?.fixable ? (
        <p className="setup-lead">
          Walnut runs on <strong>Claude Code</strong>. {problem && problem.kind !== 'claude_missing'
            ? <InlineCodeText text={problem.message} />
            : 'It is not installed on this computer yet.'}{demo && <> {DEMO_INSTALL_ONE_CLICK}</>}
        </p>
      ) : demo ? (
        <p className="setup-lead">
          Walnut runs on <strong>Claude Code</strong>. {problem && <><InlineCodeText text={problem.message} />{' '}</>}{DEMO_INSTALL_UNAVAILABLE}
        </p>
      ) : (
        <p className="setup-lead">
          Walnut runs on <strong>Claude Code</strong>. {problem && <><InlineCodeText text={problem.message} />{' '}</>}Install it, run <code>claude</code> once to sign in, then reload this page:
        </p>
      )}
      {panel && manualIsMain && <div className="setup-alt"><CopyCommand command={CLAUDE_CODE_INSTALL} /></div>}
      {install?.fixable && <FixRow view={install} label="Install Claude Code" pending={pending} error={error} panel={panel}
        onFix={() => onFix(problem!.kind)} repair={repair} secondary={panel ? apiSettings : undefined} />}
      {firstUse ? (
        <details className="first-use-alternatives" {...alternatives}>
          <summary>Other ways to connect</summary>
          {!demo && <div className="setup-alt"><CopyCommand command={CLAUDE_CODE_INSTALL} /></div>}
          <div className="setup-alt">
            <button type="button" className="btn btn-sm" onClick={() => onNavigateSettings('#providers')}>Use an API key or another provider</button>
          </div>
        </details>
      ) : (
        <>
          {!install?.fixable && <div className="ask-card-answer setup-actions">{apiSettings}{repair}</div>}
          <details className="setup-other-ways" {...otherWays}>
            <summary>Other ways to set up</summary>
            {!manualIsMain && !install?.failed?.command && !demo && (
              <div className="setup-alt setup-alt-stack">
                <span className="text-sm text-muted">Install it yourself in a terminal:</span>
                <CopyCommand command={CLAUDE_CODE_INSTALL} />
              </div>
            )}
            <p className="text-sm text-muted">Prefer an API key or Bedrock credentials instead? Add them in API settings.</p>
          </details>
        </>
      )}
    </section>
  );
}

// ── Not ready, nothing needs Claude Code: the provider Walnut's own calls go to does not answer. ──
function ProviderSection({ header, panel, health, onNavigateSettings }: {
  header: ReactNode; panel: boolean; health: SystemHealth; onNavigateSettings: (hash?: string) => void;
}) {
  const name = providerLabel(health.mainProvider);
  // credentialDetail is the server's address for a provider on the user's own machine.
  const address = health.mainProviderLocal && health.credentialDetail ? health.credentialDetail : '';
  return (
    <section className="ab-local" data-testid="setup-banner-provider">
      {header}
      {health.mainProviderLocal ? (
        <p className="setup-lead">
          Walnut runs on <strong>{name}</strong>, and it is not answering{address ? <> at <code>{address}</code></> : null}.
          {' '}{health.mainProvider === 'ollama' ? <>Start it (<code>ollama serve</code>) and</> : 'Start it and'} this notice goes away by itself.
        </p>
      ) : (
        <p className="setup-lead">
          Walnut runs on <strong>{name}</strong>, and it has no key or sign-in it can use yet. Add one in API settings.
        </p>
      )}
      <div className={panel ? 'ask-card-answer setup-actions' : 'setup-alt ab-local-alt'}>
        <span className="text-sm text-muted">Use another provider instead?</span>
        <button type="button" tabIndex={0} className="btn btn-sm" onClick={() => onNavigateSettings('#providers')}>
          Open API settings
        </button>
      </div>
    </section>
  );
}

/** The one-click fix: its button, "Installing Claude Code...", or why it failed with the command to run. */
function FixRow({ view, label, pending, error, onFix, repair, secondary, panel = false }: {
  view: ClaudeBannerView; label: string; pending: boolean; error: string | null; onFix: () => void;
  /** Fix with agent, on the same line as the section's own fix. */
  repair?: ReactNode;
  /** The section's second way, beside its main action (Open API settings). */
  secondary?: ReactNode;
  /** In the panel: the card family's buttons, the fix the one main action. */
  panel?: boolean;
}) {
  if (view.running || pending) return <div className="setup-lead" data-testid="setup-banner-fixing"><SetupProgress label={`${view.running ?? 'Starting setup'}...`} /></div>;
  const manual = view.failed?.command && !onDemo() ? view.failed.command : null;
  return (
    <>
      {view.failed && (
        <p className="setup-lead" data-testid="setup-banner-fix-failed">
          {view.failed.text}{manual ? ': run it yourself' : '.'}
        </p>
      )}
      {manual && <CopyCommand command={manual} />}
      <div className={panel ? 'ask-card-answer setup-actions' : 'setup-alt'}>
        {/* In the panel the fix is the card's one primary action. */}
        <button type="button" tabIndex={0} className={panel ? 'btn btn-sm btn-primary' : 'btn btn-sm'} disabled={pending} onClick={onFix} data-testid="setup-banner-fix">
          {view.failed ? 'Try again' : label}
        </button>
        {secondary}
        {repair}
        {error && <span className="text-sm text-muted">{error}</span>}
      </div>
    </>
  );
}

function QuietSection({ header, view, pending, error, onFix, onCheck, onRepairNavigate, firstUse }: {
  header: ReactNode; view: ClaudeBannerView; pending: boolean; error: string | null;
  onFix: () => void; onCheck: () => void; onRepairNavigate?: (to: string) => void; firstUse?: boolean;
}) {
  const problem = view.problem!;
  const signIn = view.kind === 'sign-in';
  const panel = !firstUse;
  // On the section's action line, never a line of its own (2026-10-31: BP-R4-N3-3).
  const repair = panel && <HostFixButton target={{ host: '__local__' }} name="this computer" onNavigate={onRepairNavigate} />;
  return (
    <section className="ab-local" data-testid={signIn ? 'setup-banner-sign-in' : 'setup-banner-outdated'}>
      {header}
      {signIn && canOpenClaudeSignIn()
        ? <p className="setup-lead">Choose Sign in to Claude Code below, then complete sign-in in your browser.</p>
        : signIn && demoSignInCopy() ? <p className="setup-lead">{DEMO_SIGN_IN_LEAD}</p>
        // The server's fix sentence names commands that would run in the real home.
        : !signIn && onDemo() ? <p className="setup-lead"><InlineCodeText text={firstSentence(problem.message).trim()} /> {view.fixable ? DEMO_UPDATE_ONE_CLICK : DEMO_UPDATE_UNAVAILABLE}</p>
        : <LeadText message={problem.message} />}
      {signIn ? (
        <>
          <ClaudeSignIn command={problem.commands[0] ?? 'claude'} />
          <div className={panel ? 'ask-card-answer setup-actions' : 'setup-alt'}>
            <span className="text-sm text-muted">Walnut checks again every 15 seconds and hides this once you are signed in.</span>
            <button type="button" tabIndex={0} className="btn btn-sm" disabled={pending} onClick={onCheck} data-testid="setup-banner-check">Check again</button>
            {repair}
            {error && <span className="text-sm text-muted">{error}</span>}
          </div>
        </>
      ) : view.fixable ? (
        <FixRow view={view} label="Update Claude Code" pending={pending} error={error} onFix={onFix} repair={repair} panel={panel} />
      ) : (
        <>
          {problem.commands[0] && !onDemo() && <CopyCommand command={problem.commands[0]} />}
          <div className="setup-alt">{repair}</div>
        </>
      )}
    </section>
  );
}

/**
 * The lead in two parts: the state ('... is not signed in.') and the fix
 * ('Run `claude` in a terminal and sign in.'), so the fix is never a clipped
 * sentence (N2).
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

const onDemo = () => demoSignInCopy() !== null;

function SignInCopy({ command }: { command: string }) {
  const demo = demoSignInCopy();
  if (!demo) return <CopyCommand command={command} />;
  if (!demo.command) return <span role="alert" className="text-sm text-muted" data-testid="demo-sign-in-unavailable">{DEMO_SIGN_IN_UNAVAILABLE}</span>;
  return <CopyCommand command={demo.command} />;
}

export function ClaudeSignIn({ command }: { command: string }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canOpenClaudeSignIn()) return <SignInCopy command={command} />;
  return (
    <div className="setup-alt">
      <button type="button" className="btn btn-sm" disabled={opening} onClick={() => {
        setOpening(true);
        setError(null);
        void openClaudeSignIn().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setOpening(false));
      }}>{opening ? 'Opening sign-in...' : 'Sign in to Claude Code'}</button>
      {error && <><span role="alert" className="text-sm text-muted">{error}</span><SignInCopy command={command} /></>}
    </div>
  );
}

/** The command chip and the same text Copy / Copied button the host rows use (one copy control per card). */
function CopyCommand({ command }: { command: string }) {
  return (
    <span className="setup-copy-wrap">
      {/* A click on the command presses its Copy (one copy control per card). */}
      <code className="setup-command" onClick={(e) => e.currentTarget.parentElement?.querySelector('button')?.click()} title="Click to copy">{command}</code>
      <CopyButton text={command} className="setup-copy-btn" aria-label="Copy command" title="Copy command" />
    </span>
  );
}
