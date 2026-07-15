/**
 * Notification panel — slide-out overlay from sidebar. Two zones:
 *   1. Recent — the persistent notification feed (cron / permission / errors),
 *      from NotificationProvider. Opening the panel marks all read.
 *      iPhone-style: entries with the same origin (same cron job, same session's
 *      permissions) collapse into an expandable group; tapping an entry deep-links
 *      to its session/task; each entry (and the whole feed) can be cleared.
 *   2. System — ambient health (remote hosts, data backup, embedding search).
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useNotifications, type Notification } from '@/contexts/notifications';
import { respondToPermission } from '@/api/sessions';
import { navigateToTarget } from '@/utils/open-session';
import { log } from '@/utils/log';

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
  sidebarCollapsed: boolean;
}

interface QmdStoreStats {
  totalIndexed: number;
  totalEmbedded: number;
  totalChunks: number;
  collections: Record<string, { indexed: number; embedded: number; chunks: number }>;
}

interface QmdStatus {
  model: { name: string; downloaded: boolean };
  stores: {
    memory: QmdStoreStats | null;
    notes: QmdStoreStats | null;
    tasks: QmdStoreStats | null;
    sessions: QmdStoreStats | null;
  };
  status: 'ready' | 'indexing' | 'downloading' | 'error';
  error: string | null;
  progress: { chunksEmbedded: number; totalChunks: number; store: string } | null;
}

export function NotificationPanel({ open, onClose, sidebarCollapsed }: NotificationPanelProps) {
  const { health, gitSync, loading } = useSystemHealth();
  const { feed, unreadCount, markAllRead, dismissFeed } = useNotifications();
  const [qmdStatus, setQmdStatus] = useState<QmdStatus | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  // Same-origin entries collapse into one expandable group (iPhone-style):
  // a cron job's repeated runs stack under the job name, a session's permission
  // asks stack under the session. Groups are ordered by their newest entry.
  const groups = useMemo(() => {
    const byKey = new Map<string, Notification[]>();
    for (const n of [...feed].reverse()) {
      const key = groupKeyOf(n);
      const list = byKey.get(key);
      if (list) list.push(n);
      else byKey.set(key, [n]);
    }
    return [...byKey.entries()].map(([key, items]) => ({ key, items }));
  }, [feed]);

  // Opening the panel clears the unread badge (everything in the feed is now seen).
  // Re-fires while open if new persistent events arrive (unreadCount climbs again) —
  // intentional: items seen while watching the panel should be marked read too.
  useEffect(() => {
    if (open && unreadCount > 0) markAllRead();
  }, [open, unreadCount, markAllRead]);

  // Fetch QMD status on mount, poll every 3s while indexing/downloading
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    const fetchQmd = () => {
      fetch('/api/qmd/status', { signal: ac.signal })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((data: QmdStatus) => setQmdStatus(data))
        .catch(err => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          log.warn('notifications', 'QMD status fetch failed', { error: String(err) });
        });
    };
    fetchQmd();
    const interval = setInterval(() => {
      if (qmdStatus?.status === 'indexing' || qmdStatus?.status === 'downloading') fetchQmd();
    }, 3000);
    return () => { ac.abort(); clearInterval(interval); };
  }, [open, qmdStatus?.status]);

  if (!open) return null;

  const gitOk = gitSync.protected && gitSync.consecutiveFailures < 3;

  // Portal to <body>: the panel is mounted inside the Sidebar, whose mobile
  // styles apply a transform — that turns the sidebar into the containing
  // block for position:fixed, dragging the "fixed" panel off-screen with the
  // slide animation. Rendering at the body level keeps fixed truly viewport-fixed.
  return createPortal(
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
          {/* Zone 1 — Recent: the persistent notification feed, grouped by origin. */}
          <div className="notification-section-label notification-section-label--row">
            <span>Recent</span>
            {feed.length > 0 && (
              <button
                className="notification-clear-all"
                onClick={() => { dismissFeed(); setExpandedGroups(new Set()); }}
              >
                Clear All
              </button>
            )}
          </div>
          {groups.length === 0 ? (
            <div className="notification-feed-empty">No notifications yet</div>
          ) : (
            <div className="notification-feed">
              {groups.map(({ key, items }) => {
                const expanded = expandedGroups.has(key) || items.length === 1;
                // A collapsed group must never bury an actionable entry: a newer
                // resolved permission would otherwise cover an older still-pending
                // one, hiding its Approve/Deny buttons behind "Show N more".
                const pending = items.find(i => i.kind === 'permission' && !i.resolved);
                const visible = expanded ? items : [pending ?? items[0]];
                return (
                  <div key={key} className="notification-feed-group">
                    {visible.map((n) => (
                      <FeedItem
                        key={n.id}
                        n={n}
                        // Session links open on the HOME page's session columns
                        // (the primary surface), not the /sessions page.
                        onNavigate={(to) => { navigateToTarget(to, navigate); onClose(); }}
                        onDismiss={() => dismissFeed([n.dedupKey])}
                      />
                    ))}
                    {items.length > 1 && (
                      <button
                        className="notification-group-toggle"
                        onClick={() => setExpandedGroups(prev => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })}
                      >
                        {expanded ? 'Show less' : `Show ${items.length - 1} more`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Zone 2 — System: ambient health (daemons / backup / embedding search). */}
          <div className="notification-section-label">System</div>
          {loading ? (
            <div className="notification-card">
              <span className="notification-card-icon loading">...</span>
              <span>Loading...</span>
            </div>
          ) : (
            <>
              {/* Remote daemons status */}
              {health.daemons && health.daemons.length > 0 && (
                <div className={`notification-card ${health.daemons.some(d => d.connected) ? 'ok' : 'neutral'}`}>
                  <div className="notification-card-row">
                    <span className={`notification-card-icon ${health.daemons.some(d => d.connected) ? 'ok' : 'neutral'}`}>
                      {health.daemons.some(d => d.connected) ? '\u2713' : '\u25CB'}
                    </span>
                    <span className="notification-card-label">Remote Hosts</span>
                  </div>

                  <div className="notification-card-details">
                    {health.daemons.map((d) => (
                      <div key={d.host} className="notification-detail-row">
                        <span>{d.label ?? d.host}</span>
                        <span className={`notification-detail-value ${d.connected ? 'ok' : 'muted'}`}>
                          {d.connected ? 'Connected' : 'Idle'}
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

              {/* Embedding Search status */}
              {qmdStatus && (
                <div className={`notification-card ${qmdStatus.status === 'error' ? 'warn' : 'ok'}`}>
                  <div className="notification-card-row">
                    <span className={`notification-card-icon ${
                      qmdStatus.status === 'error' ? 'error'
                        : (qmdStatus.status === 'downloading' || qmdStatus.status === 'indexing') ? 'pulsing'
                        : 'ok'
                    }`}>
                      {qmdStatus.status === 'error' ? '\u2717' : '\u2713'}
                    </span>
                    <span className="notification-card-label">Embedding Search</span>
                  </div>

                  <div className="notification-card-details">
                    <div className="notification-detail-row">
                      <span>Model</span>
                      <span className={`notification-detail-value ${
                        qmdStatus.status === 'ready' ? 'ok'
                          : qmdStatus.status === 'error' ? 'warn'
                          : ''
                      }`}>
                        {qmdStatus.model.name}{' '}
                        ({qmdStatus.status === 'ready' ? 'Ready'
                          : qmdStatus.status === 'downloading' ? 'Downloading'
                          : qmdStatus.status === 'indexing'
                            ? (qmdStatus.progress && qmdStatus.progress.totalChunks > 0
                              ? `Indexing ${qmdStatus.progress.store} ${Math.round(qmdStatus.progress.chunksEmbedded / qmdStatus.progress.totalChunks * 100)}%`
                              : 'Indexing')
                          : 'Error'})
                      </span>
                    </div>
                    {/* Memory store health */}
                    {qmdStatus.stores.memory && (
                      <div className="notification-detail-row">
                        <span>Memory</span>
                        <span className={`notification-detail-value ${
                          qmdStatus.stores.memory.totalEmbedded >= qmdStatus.stores.memory.totalIndexed ? 'ok' : 'warn'
                        }`}>
                          {qmdStatus.stores.memory.totalEmbedded}/{qmdStatus.stores.memory.totalIndexed} docs
                          {' \u00b7 '}{qmdStatus.stores.memory.totalChunks} chunks
                        </span>
                      </div>
                    )}
                    {/* Notes store health */}
                    {qmdStatus.stores.notes && (
                      <div className="notification-detail-row">
                        <span>Notes</span>
                        <span className={`notification-detail-value ${
                          qmdStatus.stores.notes.totalEmbedded >= qmdStatus.stores.notes.totalIndexed ? 'ok' : 'warn'
                        }`}>
                          {qmdStatus.stores.notes.totalEmbedded}/{qmdStatus.stores.notes.totalIndexed} docs
                          {' \u00b7 '}{qmdStatus.stores.notes.totalChunks} chunks
                        </span>
                      </div>
                    )}
                    {/* Tasks store health */}
                    {qmdStatus.stores.tasks && (
                      <div className="notification-detail-row">
                        <span>Tasks</span>
                        <span className={`notification-detail-value ${
                          qmdStatus.stores.tasks.totalEmbedded >= qmdStatus.stores.tasks.totalIndexed ? 'ok' : 'warn'
                        }`}>
                          {qmdStatus.stores.tasks.totalEmbedded}/{qmdStatus.stores.tasks.totalIndexed} docs
                          {' \u00b7 '}{qmdStatus.stores.tasks.totalChunks} chunks
                        </span>
                      </div>
                    )}
                    {/* Sessions store health */}
                    {qmdStatus.stores.sessions && (
                      <div className="notification-detail-row">
                        <span>Sessions</span>
                        <span className={`notification-detail-value ${
                          qmdStatus.stores.sessions.totalEmbedded >= qmdStatus.stores.sessions.totalIndexed ? 'ok' : 'warn'
                        }`}>
                          {qmdStatus.stores.sessions.totalEmbedded}/{qmdStatus.stores.sessions.totalIndexed} docs
                          {' \u00b7 '}{qmdStatus.stores.sessions.totalChunks} chunks
                        </span>
                      </div>
                    )}
                    {qmdStatus.error && (
                      <div className="notification-detail-row error">
                        <span className="notification-error-text">{qmdStatus.error}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * Same-origin collapse key: a session's permission asks stack together, a cron
 * job's repeated runs stack together. Everything else stands alone.
 */
function groupKeyOf(n: Notification): string {
  if (n.kind === 'permission' && n.sessionId) return `perm:${n.sessionId}`;
  if (n.kind === 'cron') return `cron:${n.title}`;
  return n.dedupKey;
}

/** Where tapping a feed entry navigates, iPhone-style. Null → inert card. */
function linkTargetOf(n: Notification): string | null {
  if (n.sessionId) return `/sessions?id=${n.sessionId}`;
  if (n.taskId) return `/tasks/${n.taskId}`;
  if (n.kind === 'skill') return '/skills';
  if (n.action?.kind === 'navigate' && n.action.to) return n.action.to;
  return null;
}

function FeedItem({ n, onNavigate, onDismiss }: {
  n: Notification;
  onNavigate: (to: string) => void;
  onDismiss: () => void;
}) {
  // Pending permission asks get inline Approve/Deny (the same endpoint the
  // session view uses). 'busy' debounces the double-tap. On success the card
  // stamps itself optimistically (`sent`) instead of waiting for the
  // session:permission-resolved WS round-trip — a dropped WS would otherwise
  // leave the buttons pending forever. The WS event later stamps the feed
  // entry itself (idempotent). On failure (e.g. the request already expired
  // on the CLI side) an inline error shows; the session deep link remains the
  // fallback.
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<'allowed' | 'denied' | null>(null);
  const [respondError, setRespondError] = useState(false);
  const resolved = n.resolved ?? sent;
  const pendingPermission = n.kind === 'permission' && !resolved && !!n.sessionId;
  // dedupKey is `perm:<requestId>` for permission entries — the requestId is
  // recovered from it because the record doesn't carry it as its own field.
  const requestId = n.dedupKey.startsWith('perm:') ? n.dedupKey.slice(5) : null;
  const target = linkTargetOf(n);

  const respond = async (allow: boolean) => {
    if (!n.sessionId || !requestId || busy) return;
    setBusy(true);
    setRespondError(false);
    try {
      await respondToPermission(n.sessionId, requestId, allow);
      setSent(allow ? 'allowed' : 'denied');
    } catch (err) {
      setRespondError(true);
      log.warn('notifications', 'inline permission respond failed', {
        sessionId: n.sessionId, requestId, error: String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`notification-feed-item notification-feed-item--${n.severity}${n.read ? '' : ' unread'}${target ? ' clickable' : ''}`}
      onClick={target ? () => onNavigate(target) : undefined}
      role={target ? 'button' : undefined}
      tabIndex={target ? 0 : undefined}
      onKeyDown={target ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(target); }
      } : undefined}
    >
      <div className="notification-feed-item-head">
        <span className={`notification-feed-dot notification-feed-dot--${n.severity}`} />
        <span className="notification-feed-item-title">{n.title}</span>
        <span className="notification-feed-item-time">{formatRelative(new Date(n.timestamp).toISOString())}</span>
        <button
          className="notification-feed-item-dismiss"
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          aria-label="Dismiss notification"
        >
          &times;
        </button>
      </div>
      {n.body && <div className="notification-feed-item-body clamped">{n.body}</div>}
      {n.kind === 'permission' && resolved && (
        <div className="notification-feed-item-resolved">
          {resolved === 'allowed' ? 'Approved' : 'Denied'}
        </div>
      )}
      {pendingPermission && (
        <div className="notification-feed-item-actions">
          <button
            className="notification-perm-btn approve"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); void respond(true); }}
          >
            Approve
          </button>
          <button
            className="notification-perm-btn deny"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); void respond(false); }}
          >
            Deny
          </button>
          {respondError && (
            <span className="notification-perm-error">Failed — open the session to respond</span>
          )}
        </div>
      )}
    </div>
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
