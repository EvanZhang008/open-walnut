/**
 * Unified notification model — the single shape every toast/feed source maps to.
 *
 * Replaces 6 bespoke toast implementations (cron, permission, operation-error,
 * sort hint, audio error) + the ambient NotificationPanel. Sources push a
 * Notification; the provider owns dedup, lifecycle (auto-dismiss), the toast
 * stack, and the persistent feed.
 */

/** Persistent kinds land in the feed + unread count; ephemeral kinds only toast. */
export type NotificationKind = 'permission' | 'cron' | 'operation-error' | 'sort' | 'audio-error' | 'skill';
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

/** A deep-link or callback the toast/feed entry can offer (e.g. "Go to Session"). */
export interface NotificationAction {
  label: string;
  /** `navigate` uses react-router; `callback` invokes onAction. */
  kind: 'navigate' | 'callback';
  to?: string;
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  timestamp: number;
  /** true → feed + unread; false → toast-only (sort, audio-error). */
  persistent: boolean;
  /** feed-only; whether the user has seen it. */
  read?: boolean;
  /** stable identity for de-dup (perm:<requestId>, cron:<job>:<ts>, …). */
  dedupKey: string;
  sessionId?: string;
  action?: NotificationAction;
  onAction?: () => void;
  /** emit a browser Notification when the tab is hidden (permission only). */
  browserNotify?: boolean;
}

/** What a source passes to notify(); id/timestamp/persistent default in-provider. */
export type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'read'> &
  Partial<Pick<Notification, 'id' | 'timestamp'>>;

/** Per-kind toast auto-dismiss duration (ms). Mirrors the legacy per-toast values. */
export const TOAST_DURATION_MS: Record<NotificationKind, number> = {
  permission: 15000,
  cron: 8000,
  'operation-error': 6000,
  sort: 3000,
  'audio-error': 8000,
  skill: 10000,
};

/** Whether a kind persists to the durable feed (vs toast-only). */
export const IS_PERSISTENT: Record<NotificationKind, boolean> = {
  permission: true,
  cron: true,
  'operation-error': true,
  sort: false,
  'audio-error': false,
  skill: true,
};
