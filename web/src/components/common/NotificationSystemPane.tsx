/**
 * System zone of the notification center: long-running status, not feed
 * entries: remote daemons, the data backup, and the embedding-search index.
 *
 * The remote hosts are ONE list, each host once (NotificationHostRow): a host
 * with a problem is the Home card's own row (same headline, buttons and Show
 * details, no x), every other host a plain status line. What is broken right
 * now (this machine's Claude Code, a host that cannot connect) is an error, so
 * it also leads the All and Errors views (NotificationProblems) and is counted
 * on the Errors badge, not here.
 *
 * Its own component for two reasons beyond file size: the search-index status
 * poll lives here, so mounting only when the System tab is showing means the
 * poll doesn't run while the user reads Errors or Automation; and the panel
 * file stays near the repo's ~500 LOC guideline.
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useAllHostStatus } from '@/hooks/useHostStatus';
import { hostProblemOf } from '@open-walnut/host-problem';
import { openHostSettings } from '@/utils/host-settings-nav';
import { NotificationHostRow } from './NotificationHostRow';
import { MachineLoadCard } from './MachineLoadCard';
import { NotificationUpdateCard } from './NotificationUpdateCard';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import '@/styles/attention-banner.css';
import '@/styles/attention-banner-dense.css';
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

export interface NotificationSystemPaneProps {
  indexStatus: SearchIndexStatus | null;
  /** Hosts switched off in Settings (the panel reads them once per open). */
  disabled: ReadonlySet<string>;
  /** Called before any navigation away (Open Settings, Open API settings): the panel closes. */
  onLeave?: () => void;
}

export const NotificationSystemPane = memo(function NotificationSystemPane(
  { indexStatus, disabled, onLeave }: NotificationSystemPaneProps,
) {
  const { health, gitSync, loading } = useSystemHealth();
  const statuses = useAllHostStatus();
  const navigate = useNavigate();
  // The panel fetched this when it opened (the rail dot needs it); the pane only reads and re-checks.
  const update = useUpdateStatus(true);
  // Open Settings lands on the host's own Settings row, as the Home card's button does.
  const onOpenSettings = useCallback((alias?: string) => {
    onLeave?.();
    openHostSettings(navigate, alias);
  }, [navigate, onLeave]);

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
      {/* Remote daemons status: every host once; a host with a problem is its Home card row. */}
      {health.daemons && health.daemons.length > 0 && (() => {
        // Any host with a banner problem (a failed connect, a banner readiness kind) warns the card.
        const warn = health.daemons.some((d) => !disabled.has(d.host)
          && ['connect', 'readiness'].includes(hostProblemOf(statuses.find((x) => x.host === d.host), { surface: 'banner' })?.type ?? ''));
        const tone = warn ? 'warn' : health.daemons.some((d) => d.connected) ? 'ok' : 'neutral';
        return (
        <div className={`notification-card ${tone}`} data-testid="nfc-remote-hosts">
          <div className="notification-card-row">
            <span className={`notification-card-icon ${tone}`}>
              {tone === 'warn' ? '⚠' : tone === 'ok' ? '✓' : '○'}
            </span>
            <span className="notification-card-label">Remote hosts</span>
          </div>

          <ul className="notification-card-details nfc-host-list">
            {health.daemons.map((d) => (
              <NotificationHostRow key={d.host} daemon={d} disabled={disabled.has(d.host)} onOpenSettings={onOpenSettings} />
            ))}
          </ul>
        </div>
        );
      })()}

      {/* What every session costs each machine: this Mac first, then every connected host. */}
      <MachineLoadCard labels={Object.fromEntries((health.daemons ?? []).map((d) => [d.host, d.label]))} />

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

      {/* Which Open Walnut runs here, and whether npm has a newer one. */}
      {update.status && (
        <NotificationUpdateCard status={update.status} checking={update.checking} onCheck={() => { void update.checkNow(); }} />
      )}

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
