/**
 * The chat's side of an engine CLI that is not signed in on the session's host (server words:
 * src/core/agents/engine-sign-in-words.ts). Under a message that waits for the sign-in (it goes
 * out by itself once the host signs in, sessions/agent-wait-resend.ts) it says so with "Open
 * Settings to sign in", Retry and Discard; as a session error line it says so with the same
 * link. The link opens Settings > Sessions at that host's sign-in row and opens its sign-in there
 * (engine-sign-in-model.ts openEngineSignIn), through the router: no page load.
 */
import { useNavigate } from 'react-router-dom';
import { parseNotSignedIn, type NotSignedIn } from '../../../../src/core/agents/engine-sign-in-words';
import { openEngineSignIn } from '@/components/settings/sections/engine-sign-in-model';
import { log } from '@/utils/log';

export { parseNotSignedIn };

function useOpenSignIn(signIn: NotSignedIn, host: string | undefined, sessionId?: string) {
  const navigate = useNavigate();
  return () => {
    log.info('session', 'open engine sign-in from the chat', { sessionId, engine: signIn.engine, host: host ?? null });
    openEngineSignIn(navigate, { engine: signIn.engine, ...(host ? { host } : {}), hostName: signIn.hostName });
  };
}

/** Under a message the host refused for want of a sign-in: it waits for Retry (today's Retry and Discard). */
export function EngineSignInNote({ signIn, host, sessionId, waits, onRetry, onDiscard }: {
  signIn: NotSignedIn;
  /** The row waits for the sign-in (QueuedMessage.waitsFor 'engine_sign_in'): it goes out by itself then. */
  waits?: boolean;
  /** The session's host key ('__local__' for this machine). */
  host: string;
  sessionId?: string;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const open = useOpenSignIn(signIn, host, sessionId);
  return (
    <div className="thread-queue-note session-msg-held-note session-msg-agent-wait" role="status" data-engine-sign-in={signIn.engine}>
      <div>{signIn.line}{waits ? ' Sign in and this message goes out by itself.' : ''}</div>
      {/* The button family (styles/buttons.css): the way on is the one action key, Retry and Discard the quiet ones. */}
      <div className="session-msg-queued-actions">
        <button type="button" className="btn btn-sm" onClick={open} data-testid="engine-sign-in-open-settings">Open Settings to sign in</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry} data-testid="send-retry">Retry</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDiscard}>Discard</button>
      </div>
    </div>
  );
}

/** The way to the sign-in on its own, for a line that says the rest itself (a failed engine switch). */
export function EngineSignInButton({ signIn, host }: { signIn: NotSignedIn; host?: string }) {
  const open = useOpenSignIn(signIn, host);
  return <button type="button" className="btn btn-sm" onClick={open} data-testid="engine-sign-in-open-settings">Open Settings to sign in</button>;
}

/** A session error line naming the missing sign-in: its words and the link (the host comes from the words). */
export function EngineSignInErrorLine({ signIn, time }: { signIn: NotSignedIn; time?: string }) {
  const open = useOpenSignIn(signIn, undefined);
  return (
    <div className="session-system-line session-system-line--error" data-engine-sign-in={signIn.engine}>
      <span className="session-system-icon">!</span>
      <span className="session-system-text">{signIn.line}</span>
      <button type="button" className="btn btn-sm btn-link" onClick={open} data-testid="engine-sign-in-open-settings">Open Settings to sign in</button>
      {time && <span className="session-system-detail session-system-time">{time}</span>}
    </div>
  );
}
