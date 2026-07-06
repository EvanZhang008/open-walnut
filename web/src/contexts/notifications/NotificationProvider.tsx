/**
 * NotificationProvider — the single source of truth for toasts + the durable feed.
 *
 * Consolidates what used to be 6 independent toast/notification implementations.
 * It owns:
 *   - a unified toast stack (top-right), with per-kind auto-dismiss
 *   - dedup by dedupKey (replaces PermissionToast's seenRequestIds ref)
 *   - the persistent feed + unread count (loaded from /api/notifications, then
 *     appended to live via the same WS events)
 *   - browser Notifications when the tab is hidden (permission only)
 *
 * Sources reach it two ways:
 *   - WS events subscribed here (cron, permission, audio-error)
 *   - the imperative notify() returned by useNotifications() (sort hints, and the
 *     OperationErrorBridge that mirrors TasksContext.operationError)
 */

import {
  createContext, useContext, useState, useRef, useCallback, useEffect, useMemo,
  type ReactNode,
} from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import {
  type Notification, type NotificationInput,
  TOAST_DURATION_MS, IS_PERSISTENT,
} from './types';

interface NotificationContextValue {
  /** Current top-right toast stack. */
  toasts: Notification[];
  /** Durable feed (persistent notifications), newest-last. */
  feed: Notification[];
  /** Count of unread feed entries. */
  unreadCount: number;
  /** Push a notification from any source. Returns the resolved id (or null if deduped away). */
  notify: (input: NotificationInput) => void;
  /** Dismiss one toast (does not remove it from the feed). */
  dismissToast: (id: string) => void;
  /** Mark all feed entries read (server + local). */
  markAllRead: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

/** Server feed record shape from GET /api/notifications. */
interface FeedRecord {
  id: string;
  kind: Notification['kind'];
  severity: Notification['severity'];
  title: string;
  body?: string;
  timestamp: number;
  read: boolean;
  dedupKey: string;
  sessionId?: string;
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Notification[]>([]);
  const [feed, setFeed] = useState<Notification[]>([]);

  // dedupKeys we've already surfaced as toasts this session — mirrors the old
  // per-component dedup but unified. Feed dedup is keyed separately (below) so a
  // toast that already auto-dismissed doesn't block its feed entry from loading.
  const toastDedup = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Removing a toast must ALSO drop its dedupKey, otherwise the key is stuck in
  // toastDedup forever this session — a manually-closed sort hint would never show
  // again, and resolved permissions would accumulate keys unbounded. Every removal
  // path (manual close, resolved, auto-dismiss) funnels through these two helpers.
  const dismissToast = useCallback((id: string) => {
    setToasts(prev => {
      const target = prev.find(t => t.id === id);
      if (target) toastDedup.current.delete(target.dedupKey);
      return prev.filter(t => t.id !== id);
    });
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  /** Remove any live toast matching a dedupKey (e.g. permission resolved). */
  const dismissToastByDedup = useCallback((dedupKey: string) => {
    toastDedup.current.delete(dedupKey);
    setToasts(prev => {
      for (const t of prev) {
        if (t.dedupKey === dedupKey) {
          const timer = timers.current.get(t.id);
          if (timer) { clearTimeout(timer); timers.current.delete(t.id); }
        }
      }
      return prev.filter(t => t.dedupKey !== dedupKey);
    });
  }, []);

  const notify = useCallback((input: NotificationInput) => {
    const persistent = input.persistent ?? IS_PERSISTENT[input.kind];
    // Toast-level dedup: don't re-show the same dedupKey while it's live.
    if (toastDedup.current.has(input.dedupKey)) return;
    toastDedup.current.add(input.dedupKey);

    const id = input.id ?? `notif-${crypto.randomUUID()}`;
    const notification: Notification = {
      ...input,
      id,
      persistent,
      timestamp: input.timestamp ?? Date.now(),
      read: false,
    };

    setToasts(prev => [...prev, notification]);

    // Append persistent notifications to the local feed. Note the asymmetry:
    // cron/permission are ALSO persisted server-side (server.ts), so they reload
    // from GET /api/notifications after a refresh; operation-error is frontend-only
    // (a transient 409, no backend write) so it shows in the feed this session but
    // is gone on refresh. Both render identically — intentional, not a bug.
    if (persistent) {
      setFeed(prev => (prev.some(f => f.dedupKey === notification.dedupKey) ? prev : [...prev, notification]));
    }

    // Auto-dismiss the toast after the per-kind lifetime. dismissToast drops the
    // dedupKey too, so the same key (e.g. a new sort change) can toast again later.
    const duration = TOAST_DURATION_MS[input.kind];
    const timer = setTimeout(() => dismissToast(id), duration);
    timers.current.set(id, timer);

    // Browser notification when the tab is hidden (permission only).
    if (input.browserNotify && typeof document !== 'undefined' && document.hidden
        && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(input.title, { body: input.body, tag: input.dedupKey });
      } catch { /* best-effort */ }
    }
  }, [dismissToast]);

  const markAllRead = useCallback(() => {
    setFeed(prev => prev.map(f => ({ ...f, read: true })));
    fetch('/api/notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(err => log.warn('notifications', 'mark-read failed', { error: String(err) }));
  }, []);

  // ── Initial feed load (server-persisted cron/permission survive refresh) ──
  useEffect(() => {
    const ac = new AbortController();
    fetch('/api/notifications', { signal: ac.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { feed: FeedRecord[]; unreadCount: number }) => {
        const loaded: Notification[] = (data.feed ?? []).map(r => ({
          id: r.id, kind: r.kind, severity: r.severity, title: r.title,
          body: r.body, timestamp: r.timestamp, persistent: true, read: r.read,
          dedupKey: r.dedupKey, sessionId: r.sessionId,
        }));
        // Merge with anything that arrived live before the fetch resolved. Live
        // entries (prev) win on identity so a stale server snapshot can't stomp a
        // fresh one — but read=true must be sticky: a live entry always carries
        // read=false, so if the server already marked this key read (e.g. another
        // tab opened the panel), OR it together so we don't resurrect the unread
        // badge for something already seen.
        setFeed(prev => {
          const byKey = new Map<string, Notification>();
          for (const n of loaded) byKey.set(n.dedupKey, n);
          for (const n of prev) {
            const server = byKey.get(n.dedupKey);
            byKey.set(n.dedupKey, server ? { ...n, read: n.read || (server.read ?? false) } : n);
          }
          return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
        });
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        log.warn('notifications', 'initial feed load failed', { error: String(err) });
      });
    return () => ac.abort();
  }, []);

  // ── WS source: cron notifications ──
  useEvent('cron:notification', (data) => {
    const { text, jobName, timestamp } = data as { text: string; jobName: string; timestamp: number };
    if (!jobName) return;
    notify({
      kind: 'cron', severity: 'info', title: jobName, body: text,
      dedupKey: `cron:${jobName}:${timestamp}`,
      persistent: true,
      ...(timestamp ? { timestamp } : {}),
    });
  });

  // ── WS source: maintainer-created skills (task-hook, no confirmation gate) ──
  useEvent('skill:notification', (data) => {
    const { name, title, body, timestamp } = data as {
      name?: string; title?: string; body?: string; timestamp?: number;
    };
    if (!name) return;
    notify({
      kind: 'skill', severity: 'success', title: title ?? `New skill: ${name}`, body,
      dedupKey: `skill:${name}:${timestamp ?? 0}`,
      persistent: true,
      ...(timestamp ? { timestamp } : {}),
      action: { label: 'Review Skill', kind: 'navigate', to: '/skills' },
    });
  });

  // ── WS source: permission requests ──
  useEvent('session:permission-request', (data) => {
    const { sessionId, requestId, toolName } = data as {
      sessionId?: string; requestId?: string; toolName?: string;
    };
    if (!sessionId || !requestId) return;
    notify({
      kind: 'permission', severity: 'warning', title: toolName ?? 'Permission',
      body: 'Session needs permission approval', sessionId,
      dedupKey: `perm:${requestId}`,
      persistent: true,
      browserNotify: true,
      action: { label: 'Go to Session', kind: 'navigate', to: `/sessions?id=${sessionId}` },
    });
  });

  // Dismiss the permission toast once it's resolved (the feed entry stays).
  // dismissToastByDedup also frees the `perm:<requestId>` dedupKey, so a LATER
  // request reusing the same requestId can toast again. (The CLI's 60s re-ask of
  // an *unresolved* permission reuses the id and is correctly suppressed until
  // either resolution or the 15s auto-dismiss frees the key.)
  useEvent('session:permission-resolved', (data) => {
    const { requestId } = data as { requestId?: string };
    if (!requestId) return;
    dismissToastByDedup(`perm:${requestId}`);
  });

  // NOTE: audio capture errors are NOT subscribed here. useAudioCapture owns the
  // audio:error handling (it also resets recording state + rewrites the perms
  // message) plus a local API-failure path with no WS event. The Sidebar mirrors
  // its `lastError` into notify() via an effect — see Sidebar.tsx.

  // Clear all pending timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => { for (const t of map.values()) clearTimeout(t); map.clear(); };
  }, []);

  const unreadCount = useMemo(() => feed.filter(f => !f.read).length, [feed]);

  const value = useMemo<NotificationContextValue>(() => ({
    toasts, feed, unreadCount, notify, dismissToast, markAllRead,
  }), [toasts, feed, unreadCount, notify, dismissToast, markAllRead]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within a NotificationProvider');
  return ctx;
}
