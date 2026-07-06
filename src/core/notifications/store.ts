/**
 * Unified notification store — durable feed behind the notification center.
 *
 * Walnut surfaces transient toasts (cron finished, permission needed, task
 * errors) AND a persistent feed in the notification center. This module owns the
 * durable side: persistent notifications accumulate into WALNUT_HOME/
 * notifications.json so the feed + unread count survive a refresh / restart.
 *
 * Pattern mirrors observability/incidents.ts: a module-level singleton guarded by
 * an in-process write lock, a bounded most-recent-N store, and a .backup safety
 * net before a non-empty → empty overwrite. Ephemeral toasts (sort hints, audio
 * errors) never reach this store — they live only in the frontend toaster.
 */

import fs from 'node:fs';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';

/** notifications.json lives next to incidents.json / sessions.json under WALNUT_HOME. */
const NOTIFICATIONS_FILE = path.join(WALNUT_HOME, 'notifications.json');
/** Keep the feed bounded — most-recent N. Older notifications drop off the tail. */
const MAX_NOTIFICATIONS = 200;

/** Persistent kinds that can land in the feed. Ephemeral kinds never persist. */
export type NotificationKind = 'permission' | 'cron' | 'operation-error' | 'skill';
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  timestamp: number;
  read: boolean;
  /** Stable identity for de-duplication (e.g. `perm:<requestId>`). */
  dedupKey: string;
  /** Optional deep-link target the UI can navigate to (e.g. a session). */
  sessionId?: string;
}

interface NotificationsStore {
  version: 1;
  notifications: NotificationRecord[];
}

/** Fields a caller supplies; id/timestamp/read are stamped here unless given. */
export type NewNotification = Omit<NotificationRecord, 'id' | 'timestamp' | 'read'> &
  Partial<Pick<NotificationRecord, 'id' | 'timestamp' | 'read'>>;

// ── In-process write lock (same pattern as observability/incidents.ts) ──

let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let release: () => void;
  writeLock = new Promise<void>(r => { release = r; });
  return prev.then(fn).finally(() => release!());
}

// ── Read / Write ──

function emptyStore(): NotificationsStore {
  return { version: 1, notifications: [] };
}

function readStore(): NotificationsStore {
  try {
    if (!fs.existsSync(NOTIFICATIONS_FILE)) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed?.notifications)) return emptyStore();
    return parsed as NotificationsStore;
  } catch (err) {
    log.notif.warn('notifications: failed to read store', { error: errMsg(err) });
    return emptyStore();
  }
}

function writeStore(store: NotificationsStore): void {
  // Cap to most-recent MAX (appended, so the tail is newest).
  if (store.notifications.length > MAX_NOTIFICATIONS) {
    store.notifications = store.notifications.slice(-MAX_NOTIFICATIONS);
  }
  // No empty→backup safety net here (unlike cron store): this module exposes only
  // add/markRead — there is no clear/delete path that could wipe the feed, so a
  // non-empty→empty transition can't happen. Mirrors observability/incidents.ts.
  fs.mkdirSync(path.dirname(NOTIFICATIONS_FILE), { recursive: true });
  fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(store, null, 2));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `notif-<epochms>-<rand>` — mirrors the inc-/qm- id style elsewhere. */
function generateId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `notif-${ts}-${rand}`;
}

// ── Public API ──

/**
 * Append a persistent notification, de-duped by dedupKey. If a notification with
 * the same dedupKey already exists it is returned unchanged (no duplicate, no
 * bump) — the re-emit timers upstream (permission re-asks every 60s) rely on this.
 * Returns the stored record (existing or new).
 */
export async function addNotification(input: NewNotification): Promise<NotificationRecord> {
  return withWriteLock(async () => {
    const store = readStore();
    const existing = store.notifications.find(n => n.dedupKey === input.dedupKey);
    if (existing) return existing;

    // Spread input FIRST, then apply defaults — so a caller passing an explicit
    // `id: undefined` / `timestamp: undefined` can't clobber the computed default
    // (which would yield a record with no id).
    const record: NotificationRecord = {
      ...input,
      id: input.id ?? generateId(),
      timestamp: input.timestamp ?? Date.now(),
      read: input.read ?? false,
    };
    store.notifications.push(record);
    writeStore(store);
    return record;
  });
}

/** The feed (newest-last insertion order) + count of unread entries. */
export async function listNotifications(): Promise<{ feed: NotificationRecord[]; unreadCount: number }> {
  return withWriteLock(async () => {
    const { notifications } = readStore();
    return { feed: notifications, unreadCount: notifications.filter(n => !n.read).length };
  });
}

/**
 * Mark notifications read. With no ids, marks ALL read (the common "opened the
 * panel" case). Returns the resulting unread count.
 */
export async function markRead(ids?: string[]): Promise<{ unreadCount: number }> {
  return withWriteLock(async () => {
    const store = readStore();
    const idSet = ids && ids.length > 0 ? new Set(ids) : null;
    for (const n of store.notifications) {
      if (!idSet || idSet.has(n.id)) n.read = true;
    }
    writeStore(store);
    return { unreadCount: store.notifications.filter(n => !n.read).length };
  });
}
