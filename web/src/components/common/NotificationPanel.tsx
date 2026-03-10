/**
 * Notification panel — slide-out overlay from sidebar showing system health.
 * iOS-style notification center: embedding status, Ollama availability, etc.
 */
import { useSystemHealth } from '@/hooks/useSystemHealth';

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
  sidebarCollapsed: boolean;
}

export function NotificationPanel({ open, onClose, sidebarCollapsed }: NotificationPanelProps) {
  const { health, gitSync, loading, reindexing, triggerReindex } = useSystemHealth();

  if (!open) return null;

  const emb = health.embedding;
  const embeddingOk = emb.unindexed === 0 && emb.ollamaAvailable;
  const gitOk = gitSync.protected && gitSync.consecutiveFailures < 3;

  return (
    <>
      {/* Backdrop */}
      <div className="notification-panel-backdrop" onClick={onClose} />

      {/* Panel */}
      <div
        className={`notification-panel${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
      >
        <div className="notification-panel-header">
          <span className="notification-panel-title">Notifications</span>
          <button className="notification-panel-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="notification-panel-body">
          {loading ? (
            <div className="notification-card">
              <span className="notification-card-icon loading">...</span>
              <span>Loading...</span>
            </div>
          ) : (
            <>
              {/* Embedding status */}
              <div className={`notification-card ${embeddingOk ? 'ok' : 'warn'}`}>
                <div className="notification-card-row">
                  <span className={`notification-card-icon ${embeddingOk ? 'ok' : 'warn'}`}>
                    {embeddingOk ? '\u2713' : '\u26A0'}
                  </span>
                  <span className="notification-card-label">Embedding</span>
                </div>

                <div className="notification-card-details">
                  <div className="notification-detail-row">
                    <span>Tasks indexed</span>
                    <span className="notification-detail-value">
                      {emb.indexed}/{emb.total}
                    </span>
                  </div>

                  {emb.unindexed > 0 && (
                    <div className="notification-detail-row warn">
                      <span>Missing embeddings</span>
                      <span className="notification-detail-value">{emb.unindexed}</span>
                    </div>
                  )}

                  <div className="notification-detail-row">
                    <span>Ollama</span>
                    <span className={`notification-detail-value ${emb.ollamaAvailable ? 'ok' : 'warn'}`}>
                      {emb.ollamaAvailable ? 'Available' : 'Unavailable'}
                    </span>
                  </div>

                  {emb.lastError && (
                    <div className="notification-detail-row error">
                      <span className="notification-error-text">{emb.lastError}</span>
                    </div>
                  )}

                  {emb.lastReconcileAt && (
                    <div className="notification-detail-row muted">
                      <span>Last check</span>
                      <span className="notification-detail-value">
                        {formatRelative(emb.lastReconcileAt)}
                      </span>
                    </div>
                  )}
                </div>

                {!embeddingOk && (
                  <button
                    className="notification-retry-btn"
                    onClick={triggerReindex}
                    disabled={reindexing}
                  >
                    {reindexing ? 'Reindexing...' : 'Retry'}
                  </button>
                )}
              </div>

              {/* Git backup status */}
              <div className={`notification-card ${gitOk ? 'ok' : 'warn'}`}>
                <div className="notification-card-row">
                  <span className={`notification-card-icon ${gitOk ? 'ok' : 'warn'}`}>
                    {gitOk ? '\u2713' : '\u26A0'}
                  </span>
                  <span className="notification-card-label">Data Backup</span>
                </div>

                <div className="notification-card-details">
                  {!gitSync.protected ? (
                    <div className="notification-detail-row warn">
                      <span>Not protected</span>
                      <span className="notification-detail-value">
                        {gitSync.error ?? 'git unavailable'}
                      </span>
                    </div>
                  ) : gitSync.consecutiveFailures >= 3 ? (
                    <>
                      <div className="notification-detail-row warn">
                        <span>Status</span>
                        <span className="notification-detail-value">Failing</span>
                      </div>
                      <div className="notification-detail-row">
                        <span>Consecutive failures</span>
                        <span className="notification-detail-value">{gitSync.consecutiveFailures}</span>
                      </div>
                      {gitSync.error && (
                        <div className="notification-detail-row error">
                          <span className="notification-error-text">{gitSync.error}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="notification-detail-row">
                      <span>Status</span>
                      <span className="notification-detail-value ok">Protected</span>
                    </div>
                  )}

                  {gitSync.lastCommitAt && (
                    <div className="notification-detail-row muted">
                      <span>Last backup</span>
                      <span className="notification-detail-value">
                        {formatRelative(gitSync.lastCommitAt)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function formatRelative(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
