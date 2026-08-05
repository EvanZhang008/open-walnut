/**
 * PendingSessionPanel — lightweight placeholder shown immediately after Quick Start
 * while waiting for the Claude Code CLI to initialize and return a real sessionId.
 * Same chrome as SessionPanel (close button, header) but no data fetching.
 *
 * Includes timeout detection + session:error event listening to surface SSH/spawn
 * failures instead of spinning forever.
 *
 * Supports retry: when an error occurs, shows Retry + Dismiss buttons.
 * On retry, clears error and resets phase to spinner state.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useEvent } from '../../hooks/useWebSocket';
import { getErrorSuggestion } from '@/utils/error-suggestions';
import { ErrorSuggestionLink } from '@/components/common/ErrorSuggestionLink';

/** Timeout thresholds (ms) */
const SLOW_THRESHOLD_MS = 20_000;    // 20s → "Taking longer than expected..."
const TIMEOUT_THRESHOLD_MS = 60_000; // 60s → auto-error

interface PendingSessionPanelProps {
  taskId: string;
  /** Real task ID for matching error events (different from taskId which is the column ID) */
  realTaskId?: string;
  cwd: string;
  host?: string;
  hostLabel?: string;
  label?: string;
  /** Pre-populated error (e.g. from HTTP failure before WS events) */
  initialError?: string;
  /** Called when user clicks Retry — parent should re-invoke quickStartSession */
  onRetry?: () => void;
  onClose: () => void;
}

export function PendingSessionPanel({ cwd, host, hostLabel, label, realTaskId, initialError, onRetry, onClose }: PendingSessionPanelProps) {
  const dirName = cwd.replace(/\/+$/, '').split('/').pop() || '/';
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [phase, setPhase] = useState<'starting' | 'slow' | 'timeout'>(initialError ? 'timeout' : 'starting');
  const [retrying, setRetrying] = useState(false);
  // Key to reset timers on retry
  const retryKeyRef = useRef(0);

  // Sync initialError from parent (e.g. when HTTP error arrives after mount)
  useEffect(() => {
    if (initialError) {
      setError(initialError);
      setRetrying(false);
    }
  }, [initialError]);

  // Listen for session:error events matching this task
  useEvent('session:error', (data: unknown) => {
    const d = data as { taskId?: string; error?: string };
    if (realTaskId && d.taskId === realTaskId) {
      setError(d.error || 'Session failed to start');
      setRetrying(false);
    }
  });

  // Also catch session:status-changed with process_status 'error' for this task
  useEvent('session:status-changed', (data: unknown) => {
    const d = data as { taskId?: string; process_status?: string };
    if (realTaskId && d.taskId === realTaskId && d.process_status === 'error') {
      setError('Session process exited with an error');
      setRetrying(false);
    }
  });

  // Phase progression timer — reset on retry via retryKey
  const retryKey = retryKeyRef.current;
  useEffect(() => {
    if (error && !retrying) return; // skip timers when showing error
    const slowTimer = setTimeout(() => setPhase('slow'), SLOW_THRESHOLD_MS);
    const timeoutTimer = setTimeout(() => setPhase('timeout'), TIMEOUT_THRESHOLD_MS);
    return () => { clearTimeout(slowTimer); clearTimeout(timeoutTimer); };
  }, [retryKey, error, retrying]);

  const handleRetry = useCallback(() => {
    setError(null);
    setPhase('starting');
    setRetrying(true);
    retryKeyRef.current += 1;
    onRetry?.();
  }, [onRetry]);

  const hasError = !retrying && (error || phase === 'timeout');
  const isRemote = !!host;

  // Build error message. A client-side fetch timeout ("operation timed out")
  // means the launch outcome is UNKNOWN — the server frequently DID start the
  // session (2026-08-03: server 200 in 2.7s, browser aborted at 15s under
  // main-thread jam). Don't blame the CLI for those; quickStartSession already
  // tried to reconcile by id before this error surfaced.
  const isClientTimeout = !!error && /operation timed out|TimeoutError/i.test(error);
  const errorMessage = error
    || (isRemote
      ? 'Session timed out — SSH connection may have failed.'
      : 'Session timed out — Claude CLI may not be available.');

  const errorHint = isClientTimeout
    ? 'The request timed out before a response arrived — the session may still have started. Check the session list before retrying (Retry may create a duplicate).'
    : isRemote
      ? 'Check your SSH credentials (e.g. run mwinit) and verify the host is reachable.'
      : 'Verify that the Claude CLI is installed and accessible.';

  if (hasError) {
    return (
      <div className="session-panel pending-session-panel">
        <div className="session-panel-header">
          <div className="session-panel-header-top">
            <div className="session-panel-title-area">
              <span className="session-panel-title" title={cwd}>{dirName}</span>
              {host && (
                <span className="session-panel-badge" style={{ color: 'var(--fg-muted)', fontSize: '10px' }}>
                  {hostLabel ?? host}
                </span>
              )}
              <span className="session-panel-badge" style={{ color: 'var(--color-error, #ff3b30)' }}>Failed</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
              <button className="session-panel-close" onClick={onClose} title="Close panel">&times;</button>
            </div>
          </div>
        </div>

        <div className="pending-session-body">
          <div className="pending-session-error-icon">!</div>
          <div className="pending-session-info">
            <span className="pending-session-label" style={{ color: 'var(--color-error, #ff3b30)' }}>
              {errorMessage}
            </span>
            <span className="pending-session-path" style={{ marginTop: 4 }}>
              {errorHint}
            </span>
            {(() => {
              const sug = getErrorSuggestion(errorMessage, { host });
              return sug ? <ErrorSuggestionLink {...sug} /> : null;
            })()}
            <span className="pending-session-path" title={cwd} style={{ marginTop: 8 }}>
              {cwd}
            </span>
          </div>
          <div className="pending-session-actions">
            {onRetry && (
              <button className="pending-session-retry-btn" onClick={handleRetry}>
                Retry
              </button>
            )}
            <button className="pending-session-dismiss-btn" onClick={onClose}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Normal / slow spinner state (including retrying)
  const statusLabel = retrying
    ? 'Retrying...'
    : (label || (phase === 'slow' ? 'Taking longer than expected...' : 'Starting session...'));
  const headerStatus = retrying ? 'Retrying...' : (phase === 'slow' ? 'Slow...' : 'Starting...');

  return (
    <div className="session-panel pending-session-panel">
      {/* Header — matches SessionPanel header-top structure */}
      <div className="session-panel-header">
        <div className="session-panel-header-top">
          <div className="session-panel-title-area">
            <span className="session-panel-title" title={cwd}>{dirName}</span>
            {host && (
              <span className="session-panel-badge" style={{ color: 'var(--fg-muted)', fontSize: '10px' }}>
                {hostLabel ?? host}
              </span>
            )}
            <span className="session-panel-badge" style={{
              color: phase === 'slow' ? 'var(--color-warning, #ff9500)' : 'var(--fg-muted)',
            }}>{headerStatus}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
            <button className="session-panel-close" onClick={onClose} title="Close panel">&times;</button>
          </div>
        </div>
      </div>

      {/* Body — spinner + path */}
      <div className="pending-session-body">
        <div className="pending-session-spinner-wrap">
          <span
            className="spinner"
            style={{ width: 20, height: 20, borderWidth: 2, display: 'inline-block' }}
          />
        </div>
        <div className="pending-session-info">
          <span className="pending-session-label" style={{
            color: phase === 'slow' ? 'var(--color-warning, #ff9500)' : undefined,
          }}>{statusLabel}</span>
          <span className="pending-session-path" title={cwd}>{cwd}</span>
        </div>
      </div>
    </div>
  );
}
