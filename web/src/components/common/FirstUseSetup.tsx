import type { SystemHealth } from '@/hooks/useSystemHealth';
import { useNavigate } from 'react-router-dom';
import { ClaudeSignIn, SetupBanner } from './SetupBanner';
import { SetupProgress } from './SetupProgress';
import { checkLocalClaude } from '@/api/local-claude';
import { localAnswerUnsettled } from '@/utils/local-claude-banner';
import { useState } from 'react';
import '@/styles/first-use.css';

export function FirstUseSetup({ health, loading }: { health: SystemHealth; loading: boolean }) {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="first-use-setup" data-testid="first-use-setup">
      <div className="first-use-card">
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
                <button type="button" className="setup-step-btn" disabled={checking} onClick={() => {
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
