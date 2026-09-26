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
import { useSystemHealth, type DaemonHealth } from '@/hooks/useSystemHealth';
import { useAllHostStatus, useHostStatus } from '@/hooks/useHostStatus';
import { hostStatusText, isHostConnecting } from '@/utils/host-connect';
import { BANNER_READINESS_KINDS, firstSentence, hostProblemOf } from '@open-walnut/host-problem';
import { fetchConfig } from '@/api/config';
import { HostStatusDot } from '@/components/sessions/path-selector/HostStatusDot';
import '@/styles/attention-banner.css';
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

/**
 * One host's row. A host that is mid-connect says which step it is on: a bare
 * "Disconnected" during the 40-second first-connect install reads as a dead host,
 * and this pane is where people look to decide whether to go fix something.
 */
/** Settings' word for a host switched off there (RemoteHostStatus DISABLED_TEXT). */
const DISABLED_TEXT = 'Disabled';

function DaemonRow({ daemon, disabled }: { daemon: DaemonHealth; disabled: boolean }) {
  const status = useHostStatus(daemon.host);
  // The live frame is the authority when there is one: the health poll lags it
  // (and knows nothing of a host the pool never dialed), so the two would disagree.
  const connected = status ? status.connected : daemon.connected;
  const connecting = !connected && isHostConnecting(status);
  // Connected is not the same as able to start work: a blocking readiness
  // problem (old or signed-out Claude Code) rides along, in the shared words.
  const problem = hostProblemOf(status);
  const blocking = problem?.type === 'readiness' ? firstSentence(problem.problem.message) : null;
  // A failed connect says why, in the card's own sentence ('Could not connect to Cert box:
  // SSH certificate expired'), not a bare 'Disconnected' under the card that said it (N14).
  const failure = !disabled && !connected && !connecting && (problem?.type === 'connect' || problem?.type === 'reconnecting')
    ? problem.type === 'connect' ? problem.headline : `Reconnecting to ${status?.label ?? daemon.label ?? daemon.host}`
    : null;
  const phase = disabled ? DISABLED_TEXT : connected ? 'Connected' : connecting ? hostStatusText(status) : failure ?? 'Disconnected';
  const label = daemon.label ?? daemon.host;
  // Only a banner problem wears the warn colour; a version floor for one model is a quiet
  // note (the user's rule, N14). A failed connect's words take its red dot's tone (N3-15).
  const bannerKind = problem?.type === 'readiness' && BANNER_READINESS_KINDS.includes(problem.problem.kind);
  const tone = disabled ? 'muted' : blocking ? (bannerKind ? 'warn' : '') : connected ? 'ok' : connecting ? '' : failure ? 'error' : 'muted';
  return (
    <div className="notification-detail-row nfc-daemon-row" data-host={daemon.host}>
      <span className="notification-daemon-name" title={label}>
        {daemon.host !== '__local__' && <HostStatusDot host={daemon.host} label={label} />}
        <span className="nfc-daemon-label">{label}</span>
      </span>
      <span
        className={`notification-detail-value nfc-daemon-status ${tone}`}
        title={blocking ? `${phase}. ${blocking}` : status ? hostStatusText(status) : undefined}
      >
        {/* 'Idle' used to render for connected:false, hiding real outages. */}
        {phase}{blocking && !disabled ? `. ${blocking}` : ''}
        {/* Cloud-bridge state (phone reachability): only when a bridge is
            configured AND the host itself is connected: bridge liveness rides
            the daemon connection, so next to 'Disconnected' any ✓/✗ is stale
            and contradictory. */}
        {connected && daemon.bridgeConnected != null && (
          <span className={`notification-detail-value ${daemon.bridgeConnected ? 'ok' : 'warn'}`}>
            {daemon.bridgeConnected ? ' · bridge ✓' : ' · bridge ✗'}
          </span>
        )}
      </span>
    </div>
  );
}

/** Hosts switched off in Settings (the health list carries no such flag); one read per pane mount. */
function useDisabledHosts(): ReadonlySet<string> {
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    fetchConfig()
      .then((c) => {
        const hosts = (c as { hosts?: Record<string, { enabled?: boolean }> }).hosts ?? {};
        if (live) setOff(new Set(Object.entries(hosts).filter(([, h]) => h?.enabled === false).map(([a]) => a)));
      })
      .catch((err) => log.warn('notifications', 'host config read failed', { error: String(err) }));
    return () => { live = false; };
  }, []);
  return off;
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
  const statuses = useAllHostStatus();
  const disabled = useDisabledHosts();

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

          <div className="notification-card-details">
            {health.daemons.map((d) => (
              <DaemonRow key={d.host} daemon={d} disabled={disabled.has(d.host)} />
            ))}
          </div>
        </div>
        );
      })()}

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
