import type { SystemHealth } from '@/hooks/useSystemHealth';
import { useNavigate } from 'react-router-dom';
import { ClaudeSignIn, SetupBanner } from './SetupBanner';
import { SetupProgress } from './SetupProgress';
import { checkLocalClaude } from '@/api/local-claude';
import { localAnswerUnsettled } from '@/utils/local-claude-banner';
import { useNoticeDismiss } from '@/utils/notice-dismiss';
import { NoticeClose } from './NoticeClose';
import { useState } from 'react';
import { firstUseCardPlace, type FirstUseCardPlace } from '@/pages/home-first-use-card';
import '@/styles/first-use.css';

/**
 * Which setup step the card stands at, for its ×: closed, the card stays hidden until this changes
 * (a sign-in done, a check that answered differently); undefined while health still loads.
 */
export function firstUseSignature(health: SystemHealth, loading: boolean): string | undefined {
  if (loading || health.hasReadyProvider === undefined) return undefined;
  if (localAnswerUnsettled(health)) return `unsettled:${health.localClaude?.claude.unknown ? 'unknown' : 'unconfirmed'}`;
  const problems = (health.localClaude?.problems ?? []).map((p) => p.kind).join(',');
  return `setup:${health.hasReadyProvider ? 'ready' : 'none'}:${health.claudeCliAvailable ? 'cli' : 'no-cli'}:${problems}`;
}

/** The welcome card's close (utils/notice-dismiss.ts), keyed by the setup step. */
export const FIRST_USE_SCOPE = 'first-use-setup';

/**
 * Where Home shows the welcome card, with its × (home-first-use-card.ts places it). Held where Home
 * decides the card (MainPage), so a closed card is no card: the Ask slot gets no `setup` and falls
 * back to its own view (a card that drew nothing inside the slot left it blank, the 2026-11-11 F4
 * white page). Closed, it stays away until the setup step changes; once setup is no longer needed
 * the close is forgotten, so a later setup problem shows the card again.
 */
export function useFirstUseCard(needsSetup: boolean, chatVisible: boolean, taskPanelShown: boolean, health: SystemHealth, loading: boolean): {
  place: FirstUseCardPlace;
  close: () => void;
} {
  const known = !loading && health.hasReadyProvider !== undefined;
  const signature = needsSetup ? firstUseSignature(health, loading) : known ? null : undefined;
  const { hidden, dismiss } = useNoticeDismiss(FIRST_USE_SCOPE, signature);
  return { place: hidden ? null : firstUseCardPlace(needsSetup, chatVisible, taskPanelShown), close: dismiss };
}

/**
 * The welcome card while setup is needed. Its × (top right, NoticeClose) is `onClose`, which
 * useFirstUseCard gives: the card goes from Home until the setup step changes; the bell's
 * notification center keeps the Claude Code or provider problem, and Settings sets it up. On first
 * use the card's × is the only one: the setup section inside draws none (SetupBanner `firstUse`).
 */
export function FirstUseSetup({ health, loading, onClose }: { health: SystemHealth; loading: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="first-use-setup" data-testid="first-use-setup">
      <div className="first-use-card">
        <NoticeClose onClose={onClose} label="Hide the welcome card until setup changes" testId="first-use-close" className="first-use-close" />
        <h1>Welcome to Walnut</h1>
        <p className="first-use-intro">Connect your AI once, then ask a quick question or start a task.</p>
        {health.hasReadyProvider && health.claudeCliAvailable && health.claudeCodeNeeded !== false && !health.localClaude?.checkedAt
          ? <SetupProgress label="Checking your AI..." />
          : localAnswerUnsettled(health)
            ? <section className="setup-banner">
                {checking ? <SetupProgress label="Checking your AI..." /> : <p>{health.localClaude?.claude.unknown ? 'Walnut could not check your AI.' : 'Walnut could not confirm your AI sign-in.'}</p>}
                {health.localClaude?.checkError && <p role="alert">{health.localClaude.checkError}</p>}
                {health.localClaude?.claude.unknown && <p>{health.localClaude.claude.unknown}</p>}
                {health.localClaude?.claude.found && <>
                  <p>If you have not signed in, sign in once, then Check again.</p>
                  <ClaudeSignIn command="claude auth login" />
                </>}
                <button type="button" className="btn" disabled={checking} onClick={() => {
                  setChecking(true); setError(null);
                  void checkLocalClaude(false).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setChecking(false));
                }}>{checking ? 'Checking...' : 'Check again'}</button>
                {error && <p role="alert">{error}</p>}
              </section>
            : <SetupBanner health={health} loading={loading} firstUse onNavigateSettings={hash => navigate(`/settings${hash ?? ''}`)} />}
        <p className="first-use-footnote">Your tasks stay on this computer. Remote hosts are optional.</p>
      </div>
    </div>
  );
}
