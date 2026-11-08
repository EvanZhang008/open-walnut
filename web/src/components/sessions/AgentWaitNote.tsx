/**
 * Under a message that waits because the coding agent cannot run on its host yet
 * (OptimisticMessage.waitsFor: Claude Code not installed, unable to start, signed
 * out). The server sends it by itself once the host reads runnable
 * (src/core/sessions/agent-wait-resend.ts); this line says so, and offers the
 * fix right here, the same one the setup card runs (SetupBanner): Install Claude
 * Code, or Sign in. Once this computer reads ready it says "Sending…" (Retry stays,
 * for a send the agent still refuses). Review round 2, D08: the only Install was in
 * System attention, and the red line stayed after the install.
 */
import { useState } from 'react';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { fixLocalClaude } from '@/api/local-claude';
import { agentCannotRun, claudeBannerView } from '@/utils/local-claude-banner';
import { ClaudeSignIn } from '@/components/common/SetupBanner';
import { SetupProgress } from '@/components/common/SetupProgress';
import { log } from '@/utils/log';

export const AGENT_READY_SENDING = 'Claude Code is ready. Sending…';
/** The server's words name the cause the send met; once this computer reads signed out instead, say that
 *  (2026-11-10 owner check: after Install it still read "Claude Code is not installed"). */
export const AGENT_SIGN_IN_LINE = 'Claude Code is installed. Sign in to Claude Code and this message goes out by itself.';

/** The note's line: the live state of this computer when known, else the words the send met. */
export function agentWaitLine(ready: boolean, liveKind: string | undefined, reason: string | undefined): string | undefined {
  if (ready) return AGENT_READY_SENDING;
  return liveKind === 'sign-in' ? AGENT_SIGN_IN_LINE : reason;
}

export function AgentWaitNote({ reason, waitsFor, local, onRetry, onDiscard }: {
  reason?: string;
  waitsFor: string;
  /** The session runs on this computer: the fix is this computer's. A remote host's fix lives on its own line. */
  local: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { health, loading } = useSystemHealth();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only this computer's own answer says anything: before it loads, the server's words stand.
  const known = local && !loading && (health.localClaude !== undefined || health.claudeCliAvailable !== undefined);
  const ready = known && !agentCannotRun(health);
  const view = local && known && !ready ? claudeBannerView(health) : null;

  const install = () => {
    const kind = view?.problem?.kind ?? waitsFor;
    setStarting(true);
    setError(null);
    fixLocalClaude(kind)
      .catch((err) => {
        log.warn('session', 'install from the waiting message failed', { kind, error: String(err) });
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setStarting(false));
  };

  return (
    <div className="thread-queue-note session-msg-held-note session-msg-agent-wait" role="status" data-agent-wait={ready ? 'ready' : waitsFor}>
      <div>{agentWaitLine(ready, view?.kind, reason)}</div>
      {/* Its own row: the Demo's sign-in command is a long path, and in the actions row it ran out of the column. */}
      {view?.kind === 'sign-in' && (
        <div className="session-msg-agent-wait-sign-in"><ClaudeSignIn command={view.problem?.commands[0] ?? 'claude'} /></div>
      )}
      {/* The same moving bar the setup card draws (review round 3: the chat said only
          "Installing Claude Code" while the install ran for minutes). */}
      {view?.kind === 'install' && (view.running || starting) && (
        <div className="session-msg-agent-wait-progress" data-testid="agent-wait-install-progress">
          <SetupProgress label={`${view.running ?? 'Starting install'}...`} />
        </div>
      )}
      {view?.kind === 'install' && !view.running && view.failed && <div className="text-sm text-muted" role="alert">{view.failed.text}</div>}
      {error && <div className="text-sm text-muted" role="alert">{error}</div>}
      <div className="session-msg-queued-actions">
        {view?.kind === 'install' && view.fixable && !view.running && !starting && (
          <button type="button" className="session-msg-retry-btn" onClick={install}>
            Install Claude Code
          </button>
        )}
        <button type="button" onClick={onRetry}>{ready ? 'Send now' : 'Retry'}</button>
        <button type="button" onClick={onDiscard}>Discard</button>
      </div>
    </div>
  );
}
