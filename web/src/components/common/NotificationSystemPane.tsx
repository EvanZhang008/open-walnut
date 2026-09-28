/**
 * System zone of the notification center — ambient health, not feed entries:
 * this machine's Claude Code (only while its notice shows), remote daemons,
 * the data backup, and the embedding-search index.
 *
 * The remote hosts are ONE list, each host once (NotificationHostRow): a host
 * with a problem is the Home card's own row (same headline, buttons and Show
 * details, no x), every other host a plain status line. The attention card
 * itself never renders in the panel, so System never lists a host twice.
 *
 * Its own component for two reasons beyond file size: the search-index status
 * poll lives here, so mounting only when the System tab is showing means the
 * poll doesn't run while the user reads Errors or Automation; and the panel
 * file stays near the repo's ~500 LOC guideline.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useAllHostStatus } from '@/hooks/useHostStatus';
import { hostProblemOf } from '@open-walnut/host-problem';
import { fetchConfig } from '@/api/config';
import { openHostSettings } from '@/utils/host-settings-nav';
import { NotificationHostRow } from './NotificationHostRow';
import { useLocalClaudeNotice } from './SetupBanner';
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

/**
 * The Errors view's "Shown in System" asks for one host's row in view (a new
 * nonce each click). The panel has already set the row's expanded flag.
 */
export interface SystemOpenHost { alias: string; nonce: number }

/**
 * Bring the asked-for host's row into view once it renders, and put the
 * keyboard on its details toggle (the link it came from is gone with Errors).
 */
function useShowHost(list: HTMLElement | null, openHost: SystemOpenHost | null): void {
  const done = useRef(0);
  useLayoutEffect(() => {
    if (!list || !openHost || done.current === openHost.nonce) return;
    const row = Array.from(list.querySelectorAll<HTMLElement>('li.hpb-row')).find((li) => li.dataset.host === openHost.alias);
    if (!row) return;
    done.current = openHost.nonce;
    row.scrollIntoView({ block: 'nearest' });
    const toggles = row.querySelectorAll<HTMLElement>('.hft-details[aria-expanded]:not([aria-controls])');
    (toggles[toggles.length - 1] ?? row.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  });
}

export interface NotificationSystemPaneProps {
  indexStatus: SearchIndexStatus | null;
  openHost?: SystemOpenHost | null;
  /** Called before any navigation away (Open Settings, Open API settings): the panel closes. */
  onLeave?: () => void;
}

export const NotificationSystemPane = memo(function NotificationSystemPane(
  { indexStatus, openHost = null, onLeave }: NotificationSystemPaneProps,
) {
  const { health, gitSync, loading } = useSystemHealth();
  const statuses = useAllHostStatus();
  const disabled = useDisabledHosts();
  const navigate = useNavigate();
  // Open Settings lands on the host's own Settings row, as the Home card's button does.
  const onOpenSettings = useCallback((alias?: string) => {
    onLeave?.();
    openHostSettings(navigate, alias);
  }, [navigate, onLeave]);
  const onNavigateSettings = useCallback((hash?: string) => {
    onLeave?.();
    navigate(`/settings${hash ?? ''}`);
  }, [navigate, onLeave]);
  // This machine's Claude Code (install / sign in), the same section the Home card leads with;
  // the bell can land here for it, so System says it too. Nothing while Claude Code is fine.
  const local = useLocalClaudeNotice({ health, loading, onNavigateSettings });
  const [list, setList] = useState<HTMLUListElement | null>(null);
  useShowHost(list, openHost);

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
      {local.present && (
        <div className="notification-card warn nfc-local-claude" data-testid="nfc-local-claude" data-kind={local.kind ?? ''}>
          <div className="notification-card-row">
            <span className="notification-card-icon warn">⚠</span>
            <span className="notification-card-label">Claude Code</span>
          </div>
          {local.node}
        </div>
      )}

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

          <ul ref={setList} className="notification-card-details nfc-host-list">
            {health.daemons.map((d) => (
              <NotificationHostRow key={d.host} daemon={d} disabled={disabled.has(d.host)} onOpenSettings={onOpenSettings} />
            ))}
          </ul>
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
