/**
 * System zone of the notification center — ambient health, not feed entries:
 * remote daemons, the data backup, and the embedding-search index.
 *
 * Its own component for two reasons beyond file size: the search-index status
 * poll lives here, so mounting only when the System tab is showing means the
 * poll doesn't run while the user reads Errors or Automation; and the panel
 * file stays near the repo's ~500 LOC guideline.
 */
import { memo, useEffect, useState } from 'react';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { formatRelative } from '@/contexts/notifications';
import { visibleInterval } from '@/utils/page-visibility';
import { log } from '@/utils/log';

interface IndexStoreStats {
  totalIndexed: number;
  totalEmbedded: number | null;
  totalChunks: number | null;
}

export interface SearchIndexStatus {
  model: { name: string; downloaded: boolean | null };
  stores: Record<string, IndexStoreStats | null>;
  status: 'ready' | 'indexing' | 'error';
  error: string | null;
}

/**
 * Search-index status, split into two rates on purpose:
 *   `enabled` (the panel is open) does ONE fetch — the System rail's warning dot
 *     needs the error state before the user ever opens the System tab, so a
 *     system-tab-only fetch would make the dot appear only after you look.
 *   `live` (the System tab is the one showing) allows the 3s progress refresh,
 *     which is the part that would otherwise poll behind Errors/Automation.
 */
export function useSearchIndexStatus(enabled: boolean, live: boolean): SearchIndexStatus | null {
  const [indexStatus, setIndexStatus] = useState<SearchIndexStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    const fetchStatus = () => {
      fetch('/api/search-index/status', { signal: ac.signal })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((data: SearchIndexStatus) => setIndexStatus(data))
        .catch(err => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          log.warn('notifications', 'search index status fetch failed', { error: String(err) });
        });
    };
    fetchStatus();
    if (!live) return () => ac.abort();
    // visibleInterval: indexing can run for many minutes — hidden tabs skip.
    const cancel = visibleInterval(() => {
      if (indexStatus?.status === 'indexing') fetchStatus();
    }, 3000);
    return () => { ac.abort(); cancel(); };
  }, [enabled, live, indexStatus?.status]);

  return indexStatus;
}

/** Whether the System zone should wear a warning marker on the rail. */
export function searchIndexUnhealthy(status: SearchIndexStatus | null): boolean {
  return status?.status === 'error';
}

/** One kind's indexed-document row. */
function StoreRow({ label, stats }: { label: string; stats: IndexStoreStats }) {
  return (
    <div className="notification-detail-row">
      <span>{label}</span>
      <span className="notification-detail-value ok">{stats.totalIndexed} docs</span>
    </div>
  );
}

export const NotificationSystemPane = memo(function NotificationSystemPane(
  { indexStatus }: { indexStatus: SearchIndexStatus | null },
) {
  const { health, gitSync, loading } = useSystemHealth();

  if (loading) {
    return (
      <div className="notification-card">
        <span className="notification-card-icon loading">...</span>
        <span>Loading...</span>
      </div>
    );
  }

  const gitOk = gitSync.protected && gitSync.consecutiveFailures < 3;

  return (
    <>
      {/* Remote daemons status */}
      {health.daemons && health.daemons.length > 0 && (
        <div className={`notification-card ${health.daemons.some(d => d.connected) ? 'ok' : 'neutral'}`}>
          <div className="notification-card-row">
            <span className={`notification-card-icon ${health.daemons.some(d => d.connected) ? 'ok' : 'neutral'}`}>
              {health.daemons.some(d => d.connected) ? '✓' : '○'}
            </span>
            <span className="notification-card-label">Remote Hosts</span>
          </div>

          <div className="notification-card-details">
            {health.daemons.map((d) => (
              <div key={d.host} className="notification-detail-row">
                <span>{d.label ?? d.host}</span>
                <span className={`notification-detail-value ${d.connected ? 'ok' : 'muted'}`}>
                  {/* 'Idle' used to render for connected:false, hiding real outages. */}
                  {d.connected ? 'Connected' : 'Disconnected'}
                  {/* Cloud-bridge state (phone reachability) — only when a bridge is
                      configured AND the host itself is connected: bridge liveness rides
                      the daemon connection, so next to 'Disconnected' any ✓/✗ is stale
                      and contradictory. */}
                  {d.connected && d.bridgeConnected != null && (
                    <span className={`notification-detail-value ${d.bridgeConnected ? 'ok' : 'warn'}`}>
                      {d.bridgeConnected ? ' · bridge ✓' : ' · bridge ✗'}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Git backup status */}
      <div className={`notification-card ${gitOk ? 'ok' : 'warn'}`}>
        <div className="notification-card-row">
          <span className={`notification-card-icon ${gitOk ? 'ok' : 'warn'}`}>
            {gitOk ? '✓' : '⚠'}
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

      {/* Embedding Search status */}
      {indexStatus && (
        <div className={`notification-card ${indexStatus.status === 'error' ? 'warn' : 'ok'}`}>
          <div className="notification-card-row">
            <span className={`notification-card-icon ${
              indexStatus.status === 'error' ? 'error'
                : indexStatus.status === 'indexing' ? 'pulsing'
                : 'ok'
            }`}>
              {indexStatus.status === 'error' ? '✗' : '✓'}
            </span>
            <span className="notification-card-label">Embedding Search</span>
          </div>

          <div className="notification-card-details">
            <div className="notification-detail-row">
              <span>Model</span>
              <span className={`notification-detail-value ${
                indexStatus.status === 'ready' ? 'ok'
                  : indexStatus.status === 'error' ? 'warn'
                  : ''
              }`}>
                {indexStatus.model.name}{' '}
                ({indexStatus.status === 'ready' ? 'Ready'
                  : indexStatus.status === 'indexing' ? 'Indexing'
                  : 'Error'})
              </span>
            </div>
            {indexStatus.stores.tasks && <StoreRow label="Tasks" stats={indexStatus.stores.tasks} />}
            {indexStatus.stores.sessions && <StoreRow label="Sessions" stats={indexStatus.stores.sessions} />}
            {indexStatus.stores.notes && <StoreRow label="Notes" stats={indexStatus.stores.notes} />}
            {indexStatus.stores.memory && <StoreRow label="Memory" stats={indexStatus.stores.memory} />}
            {indexStatus.stores.skills && <StoreRow label="Skills" stats={indexStatus.stores.skills} />}
            {indexStatus.error && (
              <div className="notification-detail-row error">
                <span className="notification-error-text">{indexStatus.error}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
});
