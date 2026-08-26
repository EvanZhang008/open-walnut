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

/** Persistent kinds that can land in the feed. Ephemeral kinds never persist.
 *  'letter' is the Human Inbox envelope: a notification whose BODY is a document
 *  living in its own durable store (src/core/human-inbox/), so the record here
 *  carries only the envelope + `letterId`. It behaves differently from every
 *  other kind in two deliberate ways — it is exempt from mark-all-read, and the
 *  200-cap evicts ordinary records before it (see withStore). */
export type NotificationKind = 'permission' | 'cron' | 'operation-error' | 'skill' | 'hook' | 'letter';
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
   *  the condition this error described is gone (see recoverNotifications), or
   *  'expired' = nothing can ever recover it (the session it belongs to is dead,
   *  or the record predates recoveryKey entirely). The UI labels an expired ERROR
   *  "Stale" — an expired PERMISSION "Session ended". */
  resolved?: 'allowed' | 'denied' | 'expired' | 'recovered';
  /** When `resolved` was stamped (epoch ms) — the retention clock for the
   *  settled-receipt prune. Absent on records settled before this landed;
   *  the prune falls back to the occurrence timestamp for those. */
  resolvedAt?: number;

  /** operation-error only — WHICH condition this error is about, so a later
   *  success can retire it. An error notification describes a CONDITION (plugin
   *  auth expired, git auto-commit failing, backup failing, disk full) and
   *  conditions recover; without this the feed was fire-and-forget and a wall of
   *  red stayed forever after the user fixed the cause. Shapes in use:
   *  `plugin:<id>`, 'git', 'git:compaction', 'backup', 'disk',
   *  `route:<METHOD> <path>`, `session:<sid>`, `task:<id>`, 'server-lifecycle',
   *  `bus:<subscriber>:<event>`, 'task-db-writers'. */
  recoveryKey?: string;

  /** operation-error only — the ROOT CAUSE this error shares with otherwise
   *  unrelated conditions (see src/core/notifications/error-cause.ts). Shapes:
   *  `host:<alias>` — the host's SSH/daemon link is down. One cause fans out
   *  into many recoveryKeys (`task:…`, `route:…`, `session:…`); this key is what
   *  lets ONE recovery signal (the daemon reconnecting) retire all of them, and
   *  what the UI groups by while they're firing. */
  causeKey?: string;

  /** operation-error only — the FAMILY this error belongs to ('Sessions', 'API',
   *  'Data & Sync', a plugin's display name, …), derived at write time by
   *  src/core/notifications/humanize.ts. The Errors rail groups by it, so three
   *  failures of one plugin read as one problem instead of three unrelated
   *  cards. Derived server-side (not in the panel) so the iOS app and /api/v1
   *  consumers get the same grouping. Absent on records written before this
   *  landed — the frontend re-derives those from `recoveryKey`. */
  category?: string;

  /** operation-error only — the RAW technical line (the old `[subsystem] {json}`
   *  body, a stack, the producer's own wording), shown behind a "Details"
   *  toggle. `body` is now the humanized one-sentence message; this is where the
   *  detail a developer needs went, instead of being the primary body a user
   *  cannot read. Capped like `body`. */
  detail?: string;

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

  /** kind 'letter' only — the Human Inbox letter this envelope points at. The
   *  document, thread and the canonical read/pin/archive state live in the letter
   *  store; this record exists so a letter shows up on the bell with everything
   *  else. `dedupKey` is `letter:<letterId>`. */
  letterId?: string;

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
 * Snapshot for the lock-free pre-checks below, or null when the file couldn't
 * be READ (as opposed to being legitimately empty). The distinction matters:
 * a pre-check that treats "corrupt file" as "nothing to do" would skip the
 * locked path — which is exactly the code that moves the corrupt file aside
 * and retries — and an edge signal like a host reconnect never re-fires, so
 * the whole fan-out would be stranded unresolved forever.
 */
async function readStoreOrNull(): Promise<NotificationsStore | null> {
  try {
    return normalizeStore(await readJsonFile<unknown>(NOTIFICATIONS_FILE, null));
  } catch {
    return null;
  }
}

/**
 * Trim the feed to MAX_NOTIFICATIONS, evicting ordinary records before letters.
 *
 * Plain notifications are EVENTS: losing the 201st cron line off the tail is the
 * point of a bounded feed. A letter envelope points at a document the human is
 * expected to read, and an error storm can produce 200 records in minutes — with
 * a flat tail-slice that storm would silently push the human's inbox rows out of
 * the feed. So letters are kept while any ordinary record is still droppable;
 * only letters overflowing the cap ON THEIR OWN fall back to the tail rule.
 * (With no letters in the feed this is byte-for-byte the old `slice(-MAX)`.)
 */
function capNotifications(records: NotificationRecord[]): NotificationRecord[] {
  const letters = records.filter(n => n.kind === 'letter');
  if (letters.length === 0) return records.slice(-MAX_NOTIFICATIONS);
  const keepOthers = Math.max(0, MAX_NOTIFICATIONS - letters.length);
  const others = records.filter(n => n.kind !== 'letter');
  // slice(-0) returns the WHOLE array, so the zero case has to be explicit.
  const kept = new Set(keepOthers === 0 ? [] : others.slice(-keepOthers));
  const trimmed = records.filter(n => n.kind === 'letter' || kept.has(n));
  return trimmed.length > MAX_NOTIFICATIONS ? trimmed.slice(-MAX_NOTIFICATIONS) : trimmed;
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
      store.notifications = capNotifications(store.notifications);
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
  // Same argument for the humanized pair: a record written before the humanizer
  // shipped gains its category + Details block on the next occurrence, so an old
  // card in a live feed joins the grouping instead of sitting in a lone 'Other'.
  'category', 'detail',
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
    // causeKey is NOT additive-refreshed like the keys above: it is the RETIRE
    // axis, and a scope-keyed card folds occurrences with different bodies. A
    // card that once failed on an ssh error and now fails on something else
    // must lose the `host:` key, or the next reconnect would stamp 'recovered'
    // on a condition that is still broken. Both publish paths always attempt
    // derivation, so an absent input causeKey reliably means "no cause this
    // occurrence" — the field follows the LATEST occurrence, either direction.
    if (input.causeKey !== undefined) existing.causeKey = input.causeKey;
    else delete existing.causeKey;
    existing.count = (existing.count ?? 1) + 1;
    existing.lastTimestamp = input.timestamp ?? Date.now();
    // Deliberate: a re-FIRE re-badges the bell — the thing is happening again,
    // so it's news even if the user already read the earlier occurrence. The
    // frontend's sticky-read behavior applies to a re-LOAD of the same
    // occurrence, which is a different event.
    existing.read = false;
    // A stamped outcome only means anything for a permission request; on any
    // other kind a fresh occurrence means the thing is happening again.
    if (existing.resolved && existing.kind !== 'permission') {
      delete existing.resolved;
      delete existing.resolvedAt;
    }
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
 *
 * kind 'letter' is EXEMPT from the mark-ALL path: a letter is a document that is
 * read by being OPENED, one at a time, so "the user glanced at the panel" must
 * not silence an unread letter the way it retires a cron line. An explicit id
 * still works — that is the path the reader (and the letter store's read-state
 * mirror) uses.
 */
export async function markRead(ids?: string[]): Promise<{ unreadCount: number }> {
  return withWriteLock(() => withStore((store) => {
    const idSet = ids && ids.length > 0 ? new Set(ids) : null;
    for (const n of store.notifications) {
      if (!idSet) {
        if (n.kind !== 'letter') n.read = true;
        continue;
      }
      if (idSet.has(n.id)) n.read = true;
    }
    return { unreadCount: store.notifications.filter(n => !n.read).length };
  }));
}

/**
 * Patch the envelope notification for a letter, found by `letter:<id>`.
 *
 * The letter store is canonical for read/pin/archive, so this is a MIRROR, not a
 * second source of truth: the bridge calls it when the agent replies (fresh
 * preview + unread again) and when the human reads a letter. Returns null when
 * no envelope exists (the letter predates the bridge, or the record was
 * dismissed) — the caller re-creates it or lets it be, never throws.
 *
 * `bump` moves the record to the tail and stamps `lastTimestamp`: a thread that
 * just gained a turn is news, and the tail is what the cap keeps.
 */
export async function updateLetterNotification(
  letterId: string,
  patch: { title?: string; body?: string; read?: boolean; bump?: boolean; timestamp?: number },
): Promise<NotificationRecord | null> {
  if (!letterId) return null;
  const dedupKey = `letter:${letterId}`;
  return withWriteLock(() => withStore((store) => {
    const idx = store.notifications.findIndex(
      n => n.kind === 'letter' && (n.letterId === letterId || n.dedupKey === dedupKey),
    );
    if (idx === -1) return null;
    const rec = store.notifications[idx];
    if (patch.title !== undefined) rec.title = patch.title;
    if (patch.body !== undefined) rec.body = patch.body;
    if (patch.read !== undefined) rec.read = patch.read;
    if (patch.bump) {
      rec.lastTimestamp = patch.timestamp ?? Date.now();
      store.notifications.splice(idx, 1);
      store.notifications.push(rec);
    }
    // Shallow clone: callers broadcast this after awaits, and a concurrent write
    // would otherwise mutate the payload under them.
    return { ...rec };
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
  // A key matches a record's CONDITION (recoveryKey) or its ROOT CAUSE
  // (causeKey): `host:<alias>` recovering must retire every card that outage
  // produced, whatever condition each one was filed under.
  const matches = (rec: NotificationRecord): boolean =>
    (!!rec.recoveryKey && keys.has(rec.recoveryKey)) || (!!rec.causeKey && keys.has(rec.causeKey));
  // Lock-free pre-check, same reasoning as expireErrorNotifications: the
  // host-connected recovery path fires on EVERY daemon (re)connect — including
  // boots on a healthy box with nothing to retire. A plain read costs no
  // cross-process lock and no write; racing a concurrent publish is harmless
  // (the card just recovers on the next signal or the boot reconcile). An
  // UNREADABLE store falls through to the locked path, which repairs it.
  const snapshot = await readStoreOrNull();
  if (snapshot && !snapshot.notifications.some(
    n => n.kind === 'operation-error' && !n.resolved && matches(n),
  )) {
    return { recovered: [] };
  }
  return withWriteLock(() => withStore((store) => {
    const recovered: NotificationRecord[] = [];
    for (const rec of store.notifications) {
      if (rec.kind !== 'operation-error' || rec.resolved) continue;
      if (!matches(rec)) continue;
      rec.resolved = 'recovered';
      rec.resolvedAt = Date.now();
      // 'info', matching the denied/expired mapping: a recovered error is a
      // settled fact, not something that still needs fixing. sectionOf() reads
      // the stamp and routes it out of the Errors rail.
      rec.severity = 'info';
      recovered.push({ ...rec });
    }
    return { recovered };
  }));
}

/**
 * Stamp `expired` on the error notifications for conditions that can never be
 * observed again — the other half of the lifecycle recoverNotifications gives.
 *
 * Recovery needs a future SUCCESS to arrive. Some conditions lose that
 * possibility: a `session:<sid>` error whose session is dead and gone will never
 * produce a clean result, so leaving it unresolved pins it in the Errors rail
 * forever with nothing that could ever retire it. 'expired' is the honest stamp
 * — it says "settled, nobody's fault, nothing to do" rather than claiming the
 * thing was fixed ('recovered' would be a lie about a session that just died).
 *
 * Same non-behaviors as recoverNotifications: never touches `read` (this is not
 * news), only `operation-error`, only `!resolved`. Returns shallow clones so the
 * caller can broadcast `notification:updated` per record.
 */
export async function expireErrorNotifications(
  recoveryKeys: string[],
): Promise<{ expired: NotificationRecord[] }> {
  if (recoveryKeys.length === 0) return { expired: [] };
  const keys = new Set(recoveryKeys);
  // Lock-free pre-check. Unlike recoverNotifications (whose callers are all
  // edge-gated polls), this is called on EVERY session death — including the
  // overwhelming majority that never errored, and including a mass reap where
  // dozens of sessions die at once. A plain read costs no cross-process lock and
  // no write; only a session that actually has cards pays for the real cycle.
  // Racing with a concurrent publish is harmless: the notification would just be
  // expired by the boot reconcile instead of now. Unreadable store → locked
  // path, which moves the corrupt file aside and retries.
  const snapshot = await readStoreOrNull();
  if (snapshot && !snapshot.notifications.some(
    n => n.kind === 'operation-error' && !n.resolved && !!n.recoveryKey && keys.has(n.recoveryKey),
  )) return { expired: [] };
  return withWriteLock(() => withStore((store) => {
    const expired: NotificationRecord[] = [];
    for (const rec of store.notifications) {
      if (rec.kind !== 'operation-error' || rec.resolved) continue;
      if (!rec.recoveryKey || !keys.has(rec.recoveryKey)) continue;
      rec.resolved = 'expired';
      rec.resolvedAt = Date.now();
      rec.severity = 'info';
      expired.push({ ...rec });
    }
    return { expired };
  }));
}

/**
 * One-time debris sweep: stamp `expired` on unresolved error records that carry
 * NO recoveryKey and are older than `olderThanMs`.
 *
 * These records predate the recovery lifecycle. They have no key, so no success
 * signal can ever reach them and no amount of fixing the underlying condition
 * will retire them — the live feed accumulated 20 such cards (nine of them the
 * SAME failing route, each hashed to its own card because the log message
 * embedded the request latency). Their conditions are also unverifiable now, so
 * 'recovered' would be a guess: 'expired' states the truth, that the record can
 * no longer be reasoned about.
 *
 * Deliberately ONE rule with no per-producer special cases, and age-gated: every
 * producer that can name a condition now passes a key, so the only records this
 * can ever match are genuine legacy debris. A keyless record written minutes ago
 * is left alone — it may be a producer that legitimately has no lifecycle (a
 * one-shot event), and stamping it the moment it appears would erase a live error.
 */
export async function expireKeylessErrorNotifications(
  olderThanMs: number,
  now = Date.now(),
): Promise<{ expired: NotificationRecord[] }> {
  const cutoff = now - olderThanMs;
  return withWriteLock(() => withStore((store) => {
    const expired: NotificationRecord[] = [];
    for (const rec of store.notifications) {
      if (rec.kind !== 'operation-error' || rec.resolved) continue;
      if (rec.recoveryKey) continue;
      // Age off the LATEST occurrence: a record that folded a repeat five minutes
      // ago describes something still happening, whatever its first-seen stamp.
      if ((rec.lastTimestamp ?? rec.timestamp) > cutoff) continue;
      rec.resolved = 'expired';
      rec.resolvedAt = now;
      rec.severity = 'info';
      expired.push({ ...rec });
    }
    return { expired };
  }));
}

/**
 * Drop RESOLVED error records older than `olderThanMs` from the feed entirely.
 *
 * A recovered/expired error is a settled receipt: worth seeing for a day or two
 * ("ah, that outage retired itself"), then pure sediment. Without this the All
 * section accumulated them until the 200-cap (61 of 76 records in the live feed
 * were settled errors), which read as "so many notifications" long after every
 * cause was gone. Only `operation-error` and only `resolved` records qualify —
 * permission history and letters are somebody else's lifecycle — and age is
 * measured off `resolvedAt` (how long it has been SETTLED), so a card stamped
 * Stale at boot still gets its retention window of visibility. Records settled
 * before `resolvedAt` existed fall back to their latest occurrence.
 *
 * Returns shallow clones of what it removed so the caller can log titles.
 */
export async function pruneResolvedErrorNotifications(
  olderThanMs: number,
  now = Date.now(),
): Promise<{ pruned: NotificationRecord[] }> {
  const cutoff = now - olderThanMs;
  const stale = (n: NotificationRecord): boolean =>
    n.kind === 'operation-error' && !!n.resolved
    && (n.resolvedAt ?? n.lastTimestamp ?? n.timestamp) <= cutoff;
  // Lock-free pre-check (see recoverNotifications): this runs on every boot,
  // usually with nothing to prune. Unreadable store → locked path repairs it.
  const snapshot = await readStoreOrNull();
  if (snapshot && !snapshot.notifications.some(stale)) return { pruned: [] };
  return withWriteLock(() => withStore((store) => {
    const pruned = store.notifications.filter(stale).map(n => ({ ...n }));
    store.notifications = store.notifications.filter(n => !stale(n));
    return { pruned };
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
