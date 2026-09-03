/**
 * SessionRetryButton — the "re-check this session" action inside the error /
 * auto-stopped banners.
 *
 * The LABEL is host-aware. "Reconnect" only makes sense for a session running on
 * another machine; a local session has nothing to reconnect to, and calling the
 * button Reconnect there made a routine local auto-stop read as a network fault
 * ("why is it local, why does it need reconnect?", 2026-09-03). Local says
 * Recheck, which is literally what the action does in both cases.
 *
 * It deliberately does NOT start a turn. Server-side (retrySession) the outcomes
 * are: 'reconnected' (the CLI was alive all along), 'resumable' (CLI gone, the
 * conversation is preserved and the next message you type resumes it),
 * 'resuming' (a message YOU had queued was re-sent), and 'pending' (the
 * conversation never reached disk, so a fresh session takes over the task).
 * Only the last one swaps in a different session, so only it uses onRetried.
 */

import { useState, useCallback } from 'react';
import { retrySession } from '@/api/sessions';
import { log } from '@/utils/log';

interface SessionRetryButtonProps {
  sessionId: string;
  onRetried?: (taskId: string) => void;   // fallback path (new session created)
  onResuming?: () => void;                 // same-session path (nothing swapped)
  /** The execution host. Absent/empty = this machine, which changes the wording. */
  host?: string | null;
}

export function SessionRetryButton({ sessionId, onRetried, onResuming, host }: SessionRetryButtonProps) {
  const remote = !!host;
  const verb = remote ? 'Reconnect' : 'Recheck';
  const [state, setState] = useState<'idle' | 'retrying' | 'error'>('idle');

  const handleRetry = useCallback(async () => {
    setState('retrying');
    try {
      const result = await retrySession(sessionId);
      log.info('session-panel', 'reconnect returned', { sessionId, status: result.status });
      if (result.status === 'pending') {
        // Only this path produces a DIFFERENT session on the same task.
        onRetried?.(result.taskId);
      } else {
        // Same session — the record's WS status event updates the UI.
        onResuming?.();
      }
    } catch (err) {
      log.warn('session-panel', 'reconnect failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      });
      setState('error');
    }
  }, [sessionId, onRetried, onResuming]);

  if (state === 'retrying') {
    return (
      <button className="session-retry-btn" disabled>
        <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5, display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} />
        {remote ? 'Reconnecting\u2026' : 'Rechecking\u2026'}
      </button>
    );
  }

  return (
    <button
      className="session-retry-btn"
      onClick={handleRetry}
      title={remote
        ? 'Re-check the host and clear this error. The conversation is kept: send a message to resume the work.'
        : 'Re-check this session and clear the error. The conversation is kept: send a message to resume the work.'}
    >
      {state === 'error' ? `${verb} failed, try again` : verb}
    </button>
  );
}
