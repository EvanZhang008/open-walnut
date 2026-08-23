/**
 * NotificationProvider — the single source of truth for toasts + the durable feed.
 *
 * Consolidates what used to be 6 independent toast/notification implementations.
 * It owns:
 *   - a unified toast stack (top-right), with per-kind auto-dismiss, gated by the
 *     SHOULD_TOAST policy (routine automation goes to the feed only)
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
  TOAST_DURATION_MS, IS_PERSISTENT, MAX_FEED_BODY_CHARS, SHOULD_TOAST,
} from './types';
import { effectiveTs } from './notification-model';

interface NotificationContextValue {
  /** Current top-right toast stack. */
  toasts: Notification[];
  /** Durable feed (persistent notifications), newest-last. */
  feed: Notification[];
  /**
   * true once the initial GET /api/notifications merge has finished — success OR
   * failure. Consumers that make a ONE-TIME decision from the feed (the panel
   * choosing its landing section on open) need to know the feed is merely empty
   * so far vs. actually empty, otherwise a slow GET lands them on the wrong tab.
   */
  loaded: boolean;
  /** Count of unread feed entries. */
  unreadCount: number;
  /** Push a notification from any source. Returns the resolved id (or null if deduped away). */
  notify: (input: NotificationInput) => void;
  /** Dismiss one toast (does not remove it from the feed). */
  dismissToast: (id: string) => void;
  /**
   * Cancel a toast's auto-dismiss timer — the toast then stays until the user
   * closes it (or the surface dismisses it itself, e.g. an answered permission's
   * 1.5s settle).
   *
   * Exists because the permission toast is now a real FORM: the 15s lifetime that
   * is right for "read this and move on" yanks the input out from under someone
   * mid-typing. The timer lives here (one map, cleared on unmount), so the toast
   * asks the owner to cancel it rather than racing it with a local hack.
   * Idempotent — a toast calls it on every interaction and only the first does work.
   */
  pinToast: (id: string) => void;
  /** Mark all feed entries read (server + local). Letters are exempt. */
  markAllRead: () => void;
  /**
   * Flip the read flag of specific feed entries LOCALLY only, addressed by
   * dedupKey. For letters: the letter store owns their read state on the server
   * (POST /api/v1/human-inbox/:id/read), so the envelope in the feed just has to
   * follow along for the bell badge without waiting for a WS round-trip.
   */
  markLocalRead: (dedupKeys: string[], read: boolean) => void;
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

/** Server feed record shape from GET /api/notifications (and the WS twins).
 *  Everything below `resolved` is server enrichment — absent on records written
 *  before that half deployed, so every reader treats it as optional.
 *  Exported so the browser spec seeds fixtures against THIS type instead of
 *  re-declaring a copy that can silently drift from the wire shape. */
export interface FeedRecord {
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
  resolved?: 'allowed' | 'denied' | 'expired' | 'recovered';
  recoveryKey?: string;
  /** humanizer output: the family the Errors rail groups by. */
  category?: string;
  /** humanizer output: the raw technical line, behind the card's Details toggle. */
  detail?: string;
  requestId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  reason?: string;
  acpOptions?: Notification['acpOptions'];
  host?: string;
  sessionTitle?: string;
  project?: string;
  count?: number;
  lastTimestamp?: number;
  /** kind 'letter' only — which letter the envelope points at. */
  letterId?: string;
}

/** Copy the enrichment fields off a wire record, omitting absent ones so a
 *  spread never overwrites a present value with undefined. */
function enrichmentOf(r: FeedRecord): Partial<Notification> {
  return {
    ...(r.requestId ? { requestId: r.requestId } : {}),
    ...(r.toolName ? { toolName: r.toolName } : {}),
    ...(r.input ? { input: r.input } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.acpOptions ? { acpOptions: r.acpOptions } : {}),
    ...(r.recoveryKey ? { recoveryKey: r.recoveryKey } : {}),
    ...(r.category ? { category: r.category } : {}),
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.host ? { host: r.host } : {}),
    ...(r.sessionTitle ? { sessionTitle: r.sessionTitle } : {}),
    ...(r.project ? { project: r.project } : {}),
    ...(r.letterId ? { letterId: r.letterId } : {}),
    ...(typeof r.count === 'number' ? { count: r.count } : {}),
    ...(typeof r.lastTimestamp === 'number' ? { lastTimestamp: r.lastTimestamp } : {}),
  };
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Notification[]>([]);
  const [feed, setFeed] = useState<Notification[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Latest feed, for callbacks that need a SNAPSHOT rather than a dependency.
  // dismissFeed's clear-all path is the only such reader: depending on `feed`
  // rebuilt the callback (and so the whole context value) on every notification,
  // re-rendering every consumer of useNotifications.
  const feedRef = useRef<Notification[]>(feed);
  useEffect(() => { feedRef.current = feed; }, [feed]);

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

  // Stop the clock on a toast the user is working in. Deliberately does NOT
  // release the dedupKey (the toast is still up, so re-toasting the same key
  // would stack a duplicate on top of the form being filled in) — the key is
  // freed by whichever removal path eventually runs.
  const pinToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (!timer) return;
    clearTimeout(timer);
    timers.current.delete(id);
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
    // Toast policy: only what needs a human NOW interrupts (permissions, hard
    // errors, hooks, the two ephemeral kinds). Routine automation — a cron run,
    // a new skill — lands in the feed + bell badge with no toast.
    const shouldToast = SHOULD_TOAST(input);

    // Toast-level dedup: don't re-show the same dedupKey while it's live. Only
    // toastable inputs consult/claim the key — a feed-only entry has no toast
    // lifetime to release it, so claiming it would wedge the key for the session.
    if (shouldToast) {
      if (toastDedup.current.has(input.dedupKey)) return;
      toastDedup.current.add(input.dedupKey);
    }

    const id = input.id ?? `notif-${crypto.randomUUID()}`;
    const notification: Notification = {
      ...input,
      id,
      persistent,
      timestamp: input.timestamp ?? Date.now(),
      read: false,
    };

    if (shouldToast) setToasts(prev => [...prev, notification]);

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
    if (shouldToast) {
      const duration = TOAST_DURATION_MS[input.kind];
      const timer = setTimeout(() => dismissToast(id), duration);
      timers.current.set(id, timer);
    }

    // Browser notification when the tab is hidden (permission only).
    if (input.browserNotify && typeof document !== 'undefined' && document.hidden
        && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(input.title, { body: input.body, tag: input.dedupKey });
      } catch { /* best-effort */ }
    }
  }, [dismissToast]);

  const markAllRead = useCallback(() => {
    // Identity-preserving: the panel re-fires this on every WS event while it is
    // open, and a blanket `prev.map(f => ({...f}))` would hand every card a new
    // object each time — a full re-render of the feed for a no-op. Already-read
    // entries keep their identity, and an all-read feed returns `prev` itself so
    // React bails out of the update entirely.
    //
    // LETTERS ARE EXEMPT (the server exempts them too): a letter is a document
    // read one at a time in the reader, so merely opening the panel must not
    // mark it read — that is how a 3am investigation report would be silently
    // "seen" and lost. Skipping them locally as well keeps the optimistic
    // update honest instead of clearing a dot the server will send back unread.
    setFeed(prev => (prev.some(f => !f.read && f.kind !== 'letter')
      ? prev.map(f => (f.read || f.kind === 'letter' ? f : { ...f, read: true }))
      : prev));
    fetch('/api/notifications/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(err => log.warn('notifications', 'mark-read failed', { error: String(err) }));
  }, []);

  const markLocalRead = useCallback((dedupKeys: string[], read: boolean) => {
    if (dedupKeys.length === 0) return;
    setFeed(prev => (prev.some(f => dedupKeys.includes(f.dedupKey) && f.read !== read)
      ? prev.map(f => (dedupKeys.includes(f.dedupKey) && f.read !== read ? { ...f, read } : f))
      : prev));
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
    // Read the snapshot from feedRef, NOT from a `feed` dependency: depending on
    // the feed rebuilt this callback — and with it the whole context value — on
    // every single notification, re-rendering every useNotifications consumer.
    const keys = dedupKeys ?? feedRef.current.map(f => f.dedupKey);
    for (const k of keys) dismissedKeys.current.add(k);
    setFeed(prev => prev.filter(f => !keys.includes(f.dedupKey)));
    if (keys.length === 0) return;
    fetch('/api/notifications/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dedupKeys: keys }),
    }).catch(err => log.warn('notifications', 'dismiss failed', { error: String(err) }));
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
          dedupKey: r.dedupKey, sessionId: r.sessionId, taskId: r.taskId,
          resolved: r.resolved,
          ...enrichmentOf(r),
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
            // effectiveTs, not timestamp: a folded recurring error keeps its
            // first-seen timestamp, so sorting on that would sink a still-firing
            // error below entries that stopped happening hours ago.
            .sort((a, b) => effectiveTs(a) - effectiveTs(b));
        });
        setLoaded(true);
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        log.warn('notifications', 'initial feed load failed', { error: String(err) });
        // Failure still ends the "waiting on the server" state: consumers that
        // defer a one-time decision until `loaded` would otherwise defer forever.
        setLoaded(true);
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

  // ── WS source: a Personal AI turn failed ──
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

  // ── WS source: every server-created feed record pushed live — the log.error()
  // bridge, cron/skill/hook records, AND permission requests (the server now
  // broadcasts the ENRICHED permission record here, which is why
  // `session:permission-request` is no longer handled HERE — the session stream
  // consumers still subscribe to it; the notification center just doesn't need a
  // second, thinner lane, and one lane means the toast always has the tool input
  // it needs to be answerable). The record is
  // already persisted server-side; this event just makes the bell update without
  // a refresh. Storm control lives in the server bridge (TTL + dedupKey), and the
  // CLI's 60s permission re-ask is not re-broadcast.
  useEvent('notification:new', (data) => {
    const r = data as FeedRecord | undefined;
    if (!r?.dedupKey || !r.title) return;
    const kind = r.kind ?? 'operation-error';
    notify({
      kind,
      severity: r.severity ?? 'error',
      title: r.title,
      body: r.body,
      dedupKey: r.dedupKey,
      persistent: true,
      ...(r.timestamp ? { timestamp: r.timestamp } : {}),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.resolved ? { resolved: r.resolved } : {}),
      ...enrichmentOf(r),
      // Permissions are the one kind worth waking a hidden tab for.
      ...(kind === 'permission' ? { browserNotify: true } : {}),
      ...(r.sessionId
        ? { action: { label: 'Go to Session', kind: 'navigate' as const, to: `/sessions?id=${r.sessionId}` } }
        : {}),
    });
  });

  // ── WS source: a folded record changed (recurring error re-fired) ──
  // Same dedupKey, count++, lastTimestamp bumped, read reset. This is an UPDATE,
  // never a new event: toasting it would re-interrupt on every repeat of a
  // failure the user already saw (the 36-identical-403s problem). It upserts
  // rather than only patching — if the record's notification:new was missed (WS
  // reconnect, or a fold that started before this tab loaded), dropping the
  // update would hide a live error until a refresh.
  //
  // Dismissal policy, which differs BY DESIGN between the two lanes: notify()
  // (the notification:new path) CLEARS the dismissal, because a fresh live event
  // is a new occurrence and a re-ask must resurrect. This path honors it instead,
  // because a dismissed record was deleted server-side — so an update naming that
  // key is describing a record the user already discarded, and the next REAL
  // occurrence will arrive as notification:new and re-arm there.
  //
  // The merge rule: fields present on the wire win, absent fields keep the base.
  // A blind rebuild from the wire record dropped a locally-stamped `resolved`
  // (session:permission-resolved stamps 'allowed' before the server record shows
  // it), flipping an answered permission back to pending mid-fold.
  useEvent('notification:updated', (data) => {
    const r = data as FeedRecord | undefined;
    if (!r?.dedupKey || !r.title) return;
    if (dismissedKeys.current.has(r.dedupKey)) return;
    const patch = (base?: Notification): Notification => ({
      ...base,
      id: base?.id ?? r.id ?? `notif-${crypto.randomUUID()}`,
      kind: r.kind ?? base?.kind ?? 'operation-error',
      severity: r.severity ?? base?.severity ?? 'error',
      title: r.title,
      ...(r.body !== undefined ? { body: r.body } : {}),
      timestamp: r.timestamp ?? base?.timestamp ?? Date.now(),
      persistent: true,
      dedupKey: r.dedupKey,
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.taskId ? { taskId: r.taskId } : {}),
      ...(r.resolved ? { resolved: r.resolved } : {}),
      ...(r.sessionId
        ? { action: { label: 'Go to Session', kind: 'navigate' as const, to: `/sessions?id=${r.sessionId}` } }
        : {}),
      ...enrichmentOf(r),
      // The server's read state wins when it sent one. Two producers share this
      // frame and they disagree ON PURPOSE: a re-FIRE (upsertNotification) sets
      // read:false server-side because the thing is happening again, while a
      // RECOVERY (recoverNotifications) deliberately leaves read untouched —
      // recovery is good news and must never re-badge the bell. Hardcoding
      // `read: false` here would have re-badged every recovered error, which is
      // exactly the noise this feature removes.
      read: typeof r.read === 'boolean' ? r.read : false,
    });
    setFeed(prev => (prev.some(f => f.dedupKey === r.dedupKey)
      ? prev.map(f => (f.dedupKey === r.dedupKey ? patch(f) : f))
      : [...prev, patch()]));
  });

  // Dismiss the permission toast once it's resolved (the feed entry stays).
  // dismissToastByDedup also frees the `perm:<requestId>` dedupKey, so a LATER
  // request reusing the same requestId can toast again. (The CLI's 60s re-ask of
  // an *unresolved* permission reuses the id and is correctly suppressed until
  // either resolution or the 15s auto-dismiss frees the key.)
  // The feed entry is stamped with the outcome instead — the panel shows it as
  // settled and drops the approve/deny actions (mirrors the server-side stamp).
  useEvent('session:permission-resolved', (data) => {
    const { requestId, allowed, cancelled, expired } = data as {
      requestId?: string; allowed?: boolean; cancelled?: boolean; expired?: boolean;
    };
    if (!requestId) return;
    dismissToastByDedup(`perm:${requestId}`);
    // Outcome mapping mirrors resolvePermissionNotification in
    // src/core/notifications/store.ts (allowed→success, denied/expired→info),
    // AND the same precedence as the server's stamp: a WITHDRAWN request
    // (cancelled/expired — session died, CLI took the ask back, superseded) also
    // carries `allowed: false`, so checking the boolean first would label it as
    // the user's "Denied". A missing outcome altogether is never stamped: it
    // would block the later correct stamp via the idempotence check.
    const resolved: 'allowed' | 'denied' | 'expired' | null =
      (cancelled === true || expired === true) ? 'expired'
      : typeof allowed === 'boolean' ? (allowed ? 'allowed' : 'denied')
      : null;
    if (!resolved) return;
    setFeed(prev => prev.map(f => (
      f.dedupKey === `perm:${requestId}` && f.resolved !== resolved
        ? { ...f, resolved, severity: resolved === 'allowed' ? 'success' : 'info' }
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
    toasts, feed, loaded, unreadCount, notify, dismissToast, pinToast, markAllRead,
    markLocalRead, dismissFeed,
  }), [toasts, feed, loaded, unreadCount, notify, dismissToast, pinToast, markAllRead,
    markLocalRead, dismissFeed]);

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
