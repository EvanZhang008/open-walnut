/**
 * PendingSessionPanel — lightweight placeholder shown immediately after Quick Start
 * while waiting for the Claude Code CLI to initialize and return a real sessionId.
 * Same chrome as SessionPanel (close button, header) but no data fetching.
 */

interface PendingSessionPanelProps {
  taskId: string;
  cwd: string;
  host?: string;
  hostLabel?: string;
  onClose: () => void;
}

export function PendingSessionPanel({ cwd, host, hostLabel, onClose }: PendingSessionPanelProps) {
  const dirName = cwd.replace(/\/+$/, '').split('/').pop() || '/';

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
            <span className="session-panel-badge" style={{ color: 'var(--fg-muted)' }}>Starting...</span>
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
          <span className="pending-session-label">Starting session...</span>
          <span className="pending-session-path" title={cwd}>{cwd}</span>
        </div>
      </div>
    </div>
  );
}
