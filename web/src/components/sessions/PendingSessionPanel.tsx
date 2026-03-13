/**
 * PendingSessionPanel — lightweight placeholder shown immediately after Quick Start
 * while waiting for the Claude Code CLI to initialize and return a real sessionId.
 * Same chrome as SessionPanel (close button, header) but no data fetching.
 *
 * Includes timeout detection + session:error event listening to surface SSH/spawn
 * failures instead of spinning forever.
 */

import { useState, useEffect } from 'react';
import { useEvent } from '../../hooks/useWebSocket';

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
  onClose: () => void;
}

export function PendingSessionPanel({ cwd, host, hostLabel, label, realTaskId, onClose }: PendingSessionPanelProps) {
  const dirName = cwd.replace(/\/+$/, '').split('/').pop() || '/';
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'starting' | 'slow' | 'timeout'>('starting');

  // Listen for session:error events matching this task
  useEvent('session:error', (data: unknown) => {
    const d = data as { taskId?: string; error?: string };
    if (realTaskId && d.taskId === realTaskId) {
      setError(d.error || 'Session failed to start');
    }
  });

  // Also catch session:status-changed with work_status 'error' for this task
  useEvent('session:status-changed', (data: unknown) => {
    const d = data as { taskId?: string; work_status?: string };
    if (realTaskId && d.taskId === realTaskId && d.work_status === 'error') {
      setError('Session process exited with an error');
    }
  });

  // Phase progression timer
  useEffect(() => {
    const slowTimer = setTimeout(() => setPhase('slow'), SLOW_THRESHOLD_MS);
    const timeoutTimer = setTimeout(() => setPhase('timeout'), TIMEOUT_THRESHOLD_MS);
    return () => { clearTimeout(slowTimer); clearTimeout(timeoutTimer); };
  }, []);

  const hasError = error || phase === 'timeout';
  const isRemote = !!host;

  // Build error message
  const errorMessage = error
    || (isRemote
      ? 'Session timed out — SSH connection may have failed.'
      : 'Session timed out — Claude CLI may not be available.');

  const errorHint = isRemote
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
            <span className="pending-session-path" title={cwd} style={{ marginTop: 8 }}>
              {cwd}
            </span>
          </div>
          <button
            className="pending-session-dismiss-btn"
            onClick={onClose}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // Normal / slow spinner state
  const statusLabel = label
    || (phase === 'slow' ? 'Taking longer than expected...' : 'Starting session...');
  const headerStatus = phase === 'slow' ? 'Slow...' : 'Starting...';

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
