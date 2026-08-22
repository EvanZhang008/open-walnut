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
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { log } from '../../logging/index.js';

/** notifications.json lives next to incidents.json / sessions.json under WALNUT_HOME. */
const NOTIFICATIONS_FILE = path.join(WALNUT_HOME, 'notifications.json');
/** Keep the feed bounded — most-recent N. Older notifications drop off the tail. */
const MAX_NOTIFICATIONS = 200;

/** Persistent kinds that can land in the feed. Ephemeral kinds never persist. */
export type NotificationKind = 'permission' | 'cron' | 'operation-error' | 'skill' | 'hook';
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
  /** Optional deep-link target for task-producing notifications (e.g. cron). */
  taskId?: string;
  /** How the notification ended, if it did.
   *  Permission: 'allowed' / 'denied' (a human answered) or 'expired' = nobody
   *  ever answered and nobody ever can (session died, the CLI withdrew the ask,
   *  or a newer request superseded it).
   *  operation-error: 'recovered' = the underlying operation succeeded again, so
   *  the condition this error described is gone (see recoverNotifications). */
  resolved?: 'allowed' | 'denied' | 'expired' | 'recovered';

  /** operation-error only — WHICH condition this error is about, so a later
   *  success can retire it. An error notification describes a CONDITION (plugin
   *  auth expired, git auto-commit failing, backup failing, disk full) and
   *  conditions recover; without this the feed was fire-and-forget and a wall of
   *  red stayed forever after the user fixed the cause. Shape: `plugin:<id>` for
   *  a plugin, else a bare subsystem name ('git', 'backup', 'disk'). */
  recoveryKey?: string;

  // ── Permission detail (so the feed can render + answer a request itself) ──
  /** Permission: the provider's request id. First-class instead of parsed back out of dedupKey. */
  requestId?: string;
  /** Permission: the tool asking for approval. */
  toolName?: string;
  /** Permission: COMPACTED tool input (see permission-detail.ts) — enough to render, bounded in size. */
  input?: Record<string, unknown>;
  /** Permission: the provider's decision reason, when it supplied one. */
  reason?: string;
  /** Permission (ACP): the option list the adapter offered. */
  acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;

  // ── Shared enrichment: enough context to act without opening the session ──
  /** Resolved hostname / host alias of the session this notification came from. */
  host?: string;
  /** Friendly label for the session (task title > session title > description > slug). */
  sessionTitle?: string;
  /** Project the session/task belongs to. */
  project?: string;

  // ── Occurrence folding (upsertNotification) ──
  /** Occurrences folded into this record. Absent = 1.
   *  On a log-bridge record this counts the 60s WINDOWS in which the error
   *  fired, not raw occurrences: the bridge's TTL absorber swallows repeats
   *  inside a window and never reaches the store, so the absorber's TTL and
   *  this counter are the same knob. Same for publishErrorNotification. */
  count?: number;
  /** Latest occurrence (epoch ms). `timestamp` stays first-seen. */
  lastTimestamp?: number;
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
//
// notifications.json has multiple writer modules (this store's callers span
// chat-history, overview-maintainer, the log-error bridge, routes) and can be
// touched from more than one process, so ALL read-modify-write cycles go
// through updateJsonFile (cross-process file lock + fresh read + atomic write).
// The in-process writeLock stays on top to keep same-process callers FIFO.

function emptyStore(): NotificationsStore {
  return { version: 1, notifications: [] };
}

/** Validate the on-disk shape; wrong version / corrupt shape → fresh store. */
function normalizeStore(raw: unknown): NotificationsStore {
  const parsed = raw as NotificationsStore | null;
  if (parsed?.version !== 1 || !Array.isArray(parsed?.notifications)) return emptyStore();
  return parsed;
}

/** Read-only snapshot. Unparseable file → empty (matches previous behavior). */
async function readStore(): Promise<NotificationsStore> {
  try {
    return normalizeStore(await readJsonFile<unknown>(NOTIFICATIONS_FILE, null));
  } catch (err) {
    log.notif.warn('notifications: failed to read store', { error: errMsg(err) });
    return emptyStore();
  }
}

/**
 * Locked read-modify-write: mutate a FRESH store under the cross-process lock,
 * apply the cap + backup safety nets, persist, and return the callback's value.
 */
async function withStore<R>(fn: (store: NotificationsStore) => R): Promise<R> {
  let out!: R;
  const apply = (raw: unknown): NotificationsStore => {
    const store = normalizeStore(raw);
    const prevCount = store.notifications.length;
    out = fn(store);
    // Cap to most-recent MAX (appended, so the tail is newest).
    if (store.notifications.length > MAX_NOTIFICATIONS) {
      store.notifications = store.notifications.slice(-MAX_NOTIFICATIONS);
    }
    // dismiss/clear can legitimately empty the feed, so guard the non-empty→empty
    // transition with a .backup snapshot (same safety net as the cron store) in
    // case the wipe turns out to be a bug rather than a user action. The file on
    // disk still holds the previous store here — the atomic write lands after.
    if (store.notifications.length === 0 && prevCount > 0) {
      try {
        fs.copyFileSync(NOTIFICATIONS_FILE, NOTIFICATIONS_FILE.replace(/\.json$/, '.backup.json'));
      } catch { /* best-effort */ }
    }
    return store;
  };
  try {
    await updateJsonFile<unknown>(NOTIFICATIONS_FILE, null, apply);
  } catch (err) {
    if (!(err instanceof Error) || !/Failed to parse/.test(err.message)) throw err;
    // Corrupt store file — previous behavior was reset-to-empty. Move the bad
    // file aside (forensics) and retry once against the fresh fallback.
    log.notif.warn('notifications: corrupt store — resetting', { error: errMsg(err) });
    try { fs.renameSync(NOTIFICATIONS_FILE, `${NOTIFICATIONS_FILE}.corrupt`); } catch { /* already gone */ }
    await updateJsonFile<unknown>(NOTIFICATIONS_FILE, null, apply);
  }
  return out;
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
  return withWriteLock(() => withStore((store) => {
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
    return record;
  }));
}

/** Optional detail fields a refresh copies over when the caller supplies them.
 *  Additive BY DESIGN: a refresh can SET a field but never clear one — an
 *  `undefined` in the input means "the caller didn't look it up this time"
 *  (enrichment is best-effort), not "the value is gone". */
const REFRESHABLE_DETAIL_KEYS = [
  'body', 'sessionId', 'taskId',
  'requestId', 'toolName', 'input', 'reason', 'acpOptions',
  'host', 'sessionTitle', 'project',
  // recoveryKey is refreshable so a record written before its producer learned
  // the key (or before this feature shipped) gains one on the next fold, and can
  // then be retired by a recovery instead of sitting red forever.
  'recoveryKey',
] as const;

/**
 * Append OR fold-in-place, and tell the caller which happened.
 *
 * `addNotification` is deliberately "first write wins" (a permission re-ask must
 * not bump the feed). A repeating ERROR wants the opposite: one entry that shows
 * the latest body and how many times it happened. So this variant refreshes the
 * existing record, bumps `count`, stamps `lastTimestamp`, keeps `id`/`timestamp`
 * (first-seen) so the UI's identity is stable, and moves the record to the tail
 * so a live recurring error can't be evicted by the 200-cap.
 *
 * `kind: 'permission'` is REJECTED here: a permission re-ask is the same pending
 * request, so folding it would make `count` read as "this happened N times" for
 * something that happened once. The permission path stays on addNotification.
 */
export async function upsertNotification(
  input: NewNotification,
): Promise<{ record: NotificationRecord; outcome: 'inserted' | 'refreshed' }> {
  if (input.kind === 'permission') {
    throw new Error(
      'upsertNotification does not accept kind:"permission" — a permission re-ask is not a '
      + 'recurrence (it would inflate count). Use addNotification (first-write-wins).',
    );
  }
  return withWriteLock(() => withStore((store) => {
    const idx = store.notifications.findIndex(n => n.dedupKey === input.dedupKey);
    if (idx === -1) {
      const record: NotificationRecord = {
        ...input,
        id: input.id ?? generateId(),
        timestamp: input.timestamp ?? Date.now(),
        read: input.read ?? false,
      };
      store.notifications.push(record);
      return { record, outcome: 'inserted' as const };
    }

    const existing = store.notifications[idx];
    existing.title = input.title;
    existing.severity = input.severity;
    for (const key of REFRESHABLE_DETAIL_KEYS) {
      const value = input[key];
      if (value !== undefined) (existing as unknown as Record<string, unknown>)[key] = value;
    }
    existing.count = (existing.count ?? 1) + 1;
    existing.lastTimestamp = input.timestamp ?? Date.now();
    // Deliberate: a re-FIRE re-badges the bell — the thing is happening again,
    // so it's news even if the user already read the earlier occurrence. The
    // frontend's sticky-read behavior applies to a re-LOAD of the same
    // occurrence, which is a different event.
    existing.read = false;
    // A stamped outcome only means anything for a permission request; on any
    // other kind a fresh occurrence means the thing is happening again.
    if (existing.resolved && existing.kind !== 'permission') delete existing.resolved;
    // Tail = most recent, which is also what the cap keeps.
    store.notifications.splice(idx, 1);
    store.notifications.push(existing);
    // Return a SHALLOW CLONE, not the live store object: callers broadcast the
    // record after awaits, and a concurrent fold would otherwise mutate the
    // payload under them (count/body changing between read and send).
    return { record: { ...existing }, outcome: 'refreshed' as const };
  }));
}

/** The feed (newest-last insertion order) + count of unread entries. */
export async function listNotifications(): Promise<{ feed: NotificationRecord[]; unreadCount: number }> {
  return withWriteLock(async () => {
    const { notifications } = await readStore();
    return { feed: notifications, unreadCount: notifications.filter(n => !n.read).length };
  });
}

/**
 * Mark notifications read. With no ids, marks ALL read (the common "opened the
 * panel" case). Returns the resulting unread count.
 */
export async function markRead(ids?: string[]): Promise<{ unreadCount: number }> {
  return withWriteLock(() => withStore((store) => {
    const idSet = ids && ids.length > 0 ? new Set(ids) : null;
    for (const n of store.notifications) {
      if (!idSet || idSet.has(n.id)) n.read = true;
    }
    return { unreadCount: store.notifications.filter(n => !n.read).length };
  }));
}

/**
 * Remove notifications from the feed. Matches by id OR dedupKey — the frontend
 * addresses entries by dedupKey because a live WS entry carries a locally
 * generated id that differs from the server record's id (dedupKey is the only
 * cross-layer identity). With no filter at all, clears the whole feed; an
 * explicitly EMPTY array is a no-op, not a wipe — the frontend's optimistic
 * `dismissFeed([])` deletes nothing locally, so treating [] as "clear all" here
 * would silently desync the UI from disk.
 * Note: dismissing a still-pending permission only removes the current record —
 * the CLI's 60s re-ask re-adds it under the same dedupKey, which is intentional
 * (an unresolved approval should come back).
 */
export async function dismissNotifications(
  filter?: { ids?: string[]; dedupKeys?: string[] },
): Promise<{ unreadCount: number; removed: number }> {
  return withWriteLock(() => withStore((store) => {
    const before = store.notifications.length;
    const idSet = filter?.ids?.length ? new Set(filter.ids) : null;
    const keySet = filter?.dedupKeys?.length ? new Set(filter.dedupKeys) : null;
    const clearAll = !filter || (filter.ids === undefined && filter.dedupKeys === undefined);
    if (idSet || keySet) {
      store.notifications = store.notifications.filter(n => !(idSet?.has(n.id) || keySet?.has(n.dedupKey)));
    } else if (clearAll) {
      store.notifications = [];
    }
    return {
      unreadCount: store.notifications.filter(n => !n.read).length,
      removed: before - store.notifications.length,
    };
  }));
}

/**
 * Stamp a permission notification with its outcome (found by `perm:<requestId>`
 * dedupKey). No-op if the record was already dismissed or aged off the feed.
 *
 * 'expired' is the outcome NOBODY chose: the session died, the CLI withdrew the
 * request, or a newer ask superseded it. Without it an unanswerable request
 * stayed `resolved: undefined` forever, which sectionOf() reads as "pending" —
 * a permanent phantom in the Needs Action rail (the live prod record
 * perm:7cc9e8ce… on a session that had been dead with status Error for days).
 */
/**
 * Retire the error notifications for conditions that just recovered.
 *
 * An error notification describes a CONDITION, and conditions recover: the user
 * re-authenticates a plugin, frees disk space, fixes the git remote. The feed
 * used to be fire-and-forget, so the wall of red stayed after the cause was gone
 * and the Errors rail became something to ignore rather than read. Every success
 * point (plugin sync, git auto-commit, backup, disk watermark) now calls this
 * with the key(s) it owns, and everything unresolved under those keys turns quiet.
 *
 * Deliberate non-behaviors:
 *   - `read` is NEVER touched. Recovery is good news; re-badging the bell to
 *     announce "the thing you fixed is fixed" is noise (this is the opposite of
 *     upsertNotification, where a re-FIRE legitimately re-badges).
 *   - only `operation-error` and only `!resolved` — a permission outcome is not
 *     ours to overwrite, and a record already recovered stays as it is.
 *
 * Returns SHALLOW CLONES of the records it changed so the caller can broadcast
 * `notification:updated` per record without handing out live store objects.
 */
export async function recoverNotifications(
  recoveryKeys: string[],
): Promise<{ recovered: NotificationRecord[] }> {
  if (recoveryKeys.length === 0) return { recovered: [] };
  const keys = new Set(recoveryKeys);
  return withWriteLock(() => withStore((store) => {
    const recovered: NotificationRecord[] = [];
    for (const rec of store.notifications) {
      if (rec.kind !== 'operation-error' || rec.resolved) continue;
      if (!rec.recoveryKey || !keys.has(rec.recoveryKey)) continue;
      rec.resolved = 'recovered';
      // 'info', matching the denied/expired mapping: a recovered error is a
      // settled fact, not something that still needs fixing. sectionOf() reads
      // the stamp and routes it out of the Errors rail.
      rec.severity = 'info';
      recovered.push({ ...rec });
    }
    return { recovered };
  }));
}

export async function resolvePermissionNotification(
  requestId: string,
  resolved: 'allowed' | 'denied' | 'expired',
): Promise<void> {
  return withWriteLock(() => withStore((store) => {
    const rec = store.notifications.find(n => n.dedupKey === `perm:${requestId}`);
    if (!rec || rec.resolved === resolved) return;
    rec.resolved = resolved;
    // denied/expired → 'info' (not warning/error): a deny is a neutral user
    // decision and an expiry is a neutral fact about a dead session — nothing
    // needs fixing in either. NotificationProvider mirrors this mapping for the
    // optimistic client-side stamp — keep the two in sync.
    rec.severity = resolved === 'allowed' ? 'success' : 'info';
  }));
}
