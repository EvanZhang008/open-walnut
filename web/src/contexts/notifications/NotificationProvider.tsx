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
import { stripEntityRefsToText, extractFirstRefIds } from '@/utils/markdown';
import {
  type Notification, type NotificationInput,
  TOAST_DURATION_MS, IS_PERSISTENT, MAX_FEED_BODY_CHARS,
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
  /**
   * Remove feed entries (server + local), addressed by dedupKey — NOT
   * Notification.id (live WS entries carry a frontend-local id the server has
   * never seen). No argument = clear the whole feed; an explicitly empty array
   * is a no-op.
   */
  dismissFeed: (dedupKeys?: string[]) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

/** Min gap between toasts for the SAME agent-error message. Wider than the cron
 *  interval (30min) so a persistent failure toasts about twice an hour, not 36x. */
const AGENT_ERROR_TOAST_THROTTLE_MS = 10 * 60 * 1000;

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
  taskId?: string;
  resolved?: 'allowed' | 'denied';
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Notification[]>([]);
  const [feed, setFeed] = useState<Notification[]>([]);

  // dedupKeys we've already surfaced as toasts this session — mirrors the old
  // per-component dedup but unified. Feed dedup is keyed separately (below) so a
  // toast that already auto-dismissed doesn't block its feed entry from loading.
  const toastDedup = useRef(new Set<string>());
  /** agent:error → last toast time per dedupKey (see AGENT_ERROR_TOAST_THROTTLE_MS). */
  const errorToastAt = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // dedupKeys the user dismissed this session — a slow initial GET resolving
  // after a dismiss must not resurrect the entry via the merge below.
  const dismissedKeys = useRef(new Set<string>());

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
    // cron/permission/server-side operation-error (the log.error bridge) are
    // ALSO persisted server-side, so they reload from GET /api/notifications
    // after a refresh; frontend-born operation-error (OperationErrorBridge, a
    // transient 409 with no backend write) shows in the feed this session but
    // is gone on refresh. Both render identically — intentional, not a bug.
    if (persistent) {
      // A fresh live event supersedes a prior dismissal of the same key (e.g.
      // the CLI's 60s permission re-ask after the user dismissed the entry) —
      // drop the guard so the initial-GET merge can't swallow the re-added entry.
      dismissedKeys.current.delete(notification.dedupKey);
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

  // Remove feed entries locally + server-side. Addressed by dedupKey (NOT id):
  // entries appended live over WS carry a frontend-local id that differs from
  // the server record's id — dedupKey is the only cross-layer identity.
  // Optimistic: the local list drops immediately; dismissedKeys guards against
  // a slow initial GET re-adding them via the merge below.
  const dismissFeed = useCallback((dedupKeys?: string[]) => {
    // Explicitly empty array = no-op (the optimistic local filter would delete
    // nothing either) — never escalate it into a server-side clear-all.
    if (dedupKeys && dedupKeys.length === 0) return;
    // "Clear all" sends a snapshot of the currently-known keys instead of an
    // unfiltered server wipe: a notification landing between the click and the
    // server's write lock would otherwise be deleted on disk while the WS
    // handler had already surfaced it locally — a ghost entry gone on refresh.
    const keys = dedupKeys ?? feed.map(f => f.dedupKey);
    for (const k of keys) dismissedKeys.current.add(k);
    setFeed(prev => prev.filter(f => !keys.includes(f.dedupKey)));
    if (keys.length === 0) return;
    fetch('/api/notifications/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dedupKeys: keys }),
    }).catch(err => log.warn('notifications', 'dismiss failed', { error: String(err) }));
  }, [feed]);

  // ── Initial feed load (server-persisted cron/permission survive refresh) ──
  useEffect(() => {
    const ac = new AbortController();
    fetch('/api/notifications', { signal: ac.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { feed: FeedRecord[]; unreadCount: number }) => {
        const loaded: Notification[] = (data.feed ?? []).map(r => ({
          id: r.id, kind: r.kind, severity: r.severity, title: r.title,
          body: r.body, timestamp: r.timestamp, persistent: true, read: r.read,
          dedupKey: r.dedupKey, sessionId: r.sessionId, taskId: r.taskId,
          resolved: r.resolved,
        }));
        // Merge with anything that arrived live before the fetch resolved. Live
        // entries (prev) win on identity so a stale server snapshot can't stomp a
        // fresh one — but read=true must be sticky: a live entry always carries
        // read=false, so if the server already marked this key read (e.g. another
        // tab opened the panel), OR it together so we don't resurrect the unread
        // badge for something already seen. Keys dismissed while the fetch was in
        // flight stay dismissed (the server delete may have landed after this
        // snapshot was taken).
        setFeed(prev => {
          const byKey = new Map<string, Notification>();
          for (const n of loaded) byKey.set(n.dedupKey, n);
          for (const n of prev) {
            const server = byKey.get(n.dedupKey);
            byKey.set(n.dedupKey, server ? { ...n, read: n.read || (server.read ?? false) } : n);
          }
          return [...byKey.values()]
            .filter(n => !dismissedKeys.current.has(n.dedupKey))
            .sort((a, b) => a.timestamp - b.timestamp);
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
    // The WS payload carries the raw agent output (chat rendering needs the ref
    // pills); toast + feed are plain-text surfaces, so strip refs here and lift
    // the first session/task id out as the deep-link target — mirrors what the
    // server persists (server.ts broadcastCronNotification). Truncate to the
    // same bound the server applies on GET so the entry doesn't change shape
    // after a refresh.
    const { sessionId, taskId } = extractFirstRefIds(text ?? '');
    const body = stripEntityRefsToText(text ?? '');
    notify({
      kind: 'cron', severity: 'info', title: jobName,
      body: body.length > MAX_FEED_BODY_CHARS ? `${body.slice(0, MAX_FEED_BODY_CHARS)}…` : body,
      dedupKey: `cron:${jobName}:${timestamp}`,
      persistent: true,
      ...(timestamp ? { timestamp } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(taskId ? { taskId } : {}),
    });
  });

  // ── WS source: a butler turn failed ──
  // Nothing subscribed to this before, so a total outage was silent on every
  // surface (2026-07-26: 18h / 36 cron runs of `403 invalid security token`, with
  // the only trace a server log line). Auth failures are the important class:
  // they mean EVERY subsequent turn fails too, not a one-off blip.
  useEvent('agent:error', (data) => {
    const { error, agentId } = (data ?? {}) as { error?: string; agentId?: string };
    if (!error) return;
    const isAuth = /security token|credential|expired|unauthor|forbidden|\b(401|403)\b|invalidclienttoken|accessdenied/i
      .test(error);
    const key = `agent-error:${agentId ?? 'general'}:${error.slice(0, 120)}`;
    // Throttle across toast lifetimes. notify()'s own dedup is released when the
    // toast auto-dismisses (6s), so a recurring failure — cron retrying every
    // 30min — would toast on every single attempt. One per key per window keeps
    // the signal without training the user to ignore it.
    const lastAt = errorToastAt.current.get(key) ?? 0;
    if (Date.now() - lastAt < AGENT_ERROR_TOAST_THROTTLE_MS) return;
    errorToastAt.current.set(key, Date.now());
    notify({
      kind: 'operation-error',
      severity: isAuth ? 'error' : 'warning',
      title: isAuth ? 'Agent auth failed — every turn will fail' : 'Agent turn failed',
      body: error.length > MAX_FEED_BODY_CHARS ? `${error.slice(0, MAX_FEED_BODY_CHARS)}…` : error,
      // Keyed by message (not timestamp) so 36 identical 403s collapse into ONE
      // feed entry — that noise is what makes users tune notifications out.
      dedupKey: key,
      persistent: true,
      ...(isAuth ? { action: { label: 'Open Settings', kind: 'navigate' as const, to: '/settings' } } : {}),
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

  // ── WS source: server-side log.error() bridge (and any other server-created
  // feed record pushed live). The record is already persisted server-side; this
  // event just makes the bell update without a refresh. Storm control lives in
  // the server bridge (TTL + dedupKey), so a plain notify() here is safe.
  useEvent('notification:new', (data) => {
    const r = data as FeedRecord | undefined;
    if (!r?.dedupKey || !r.title) return;
    notify({
      kind: r.kind ?? 'operation-error',
      severity: r.severity ?? 'error',
      title: r.title,
      body: r.body,
      dedupKey: r.dedupKey,
      persistent: true,
      ...(r.timestamp ? { timestamp: r.timestamp } : {}),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.sessionId
        ? { action: { label: 'Go to Session', kind: 'navigate' as const, to: `/sessions?id=${r.sessionId}` } }
        : {}),
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
  // The feed entry is stamped with the outcome instead — the panel shows it as
  // settled and drops the approve/deny actions (mirrors the server-side stamp).
  useEvent('session:permission-resolved', (data) => {
    const { requestId, allowed } = data as { requestId?: string; allowed?: boolean };
    if (!requestId) return;
    dismissToastByDedup(`perm:${requestId}`);
    // `allowed` is optional on the event — never stamp a missing outcome as
    // "denied". Severity mapping (allowed→success, denied→info) mirrors
    // resolvePermissionNotification in src/core/notifications/store.ts.
    if (typeof allowed !== 'boolean') return;
    const resolved = allowed ? 'allowed' as const : 'denied' as const;
    setFeed(prev => prev.map(f => (
      f.dedupKey === `perm:${requestId}` && f.resolved !== resolved
        ? { ...f, resolved, severity: allowed ? 'success' : 'info' }
        : f
    )));
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
    toasts, feed, unreadCount, notify, dismissToast, markAllRead, dismissFeed,
  }), [toasts, feed, unreadCount, notify, dismissToast, markAllRead, dismissFeed]);

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
