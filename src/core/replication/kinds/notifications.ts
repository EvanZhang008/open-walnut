/**
 * The `notifications` copy kind (stage 4d of docs/plan/walnut-companion-unified-replica.md):
 * the Mac's notification feed, one row per card keyed by its id, in
 * `cache/replica/notifications.json` (file-copy.ts), never the live file. Git sync no
 * longer writes the companion's data dir, so this copy is how the box's console shows the
 * Mac's cards while the Mac is away (core/notifications/companion-feed.ts), and the phone's
 * feed too (routes/search-memory-v1.ts). Read only there: mark-read and dismiss still need
 * the Mac. Rides the `inbox` choice: the feed carries the letters' envelopes.
 *
 * The removal floor is above the feed's cap (200 cards), so the half rule never holds a
 * round back: a feed the human cleared on the Mac is an ordinary change, and a card is an
 * event, not a document a wrong round could lose.
 */

import { listNotifications, onNotificationStoreWritten, type NotificationRecord } from '../../notifications/store.js'
import { sha12 } from '../kind.js'
import type { CopyKind } from './copy-kind.js'
import { createFileCopy } from './file-copy.js'
import { copyKindAsOf, keepsCopies } from './gate.js'

export const NOTIFICATIONS_SCHEMA_VERSION = 1
export const NOTIFICATIONS_REMOVAL_FLOOR = 201
const MAX_CARD_BYTES = 64 * 1024

export const NOTIFICATIONS_KIND: CopyKind<NotificationRecord> = {
  kind: 'notifications',
  schemaVersion: NOTIFICATIONS_SCHEMA_VERSION,
  key: (r) => r.id,
  // The follower's own hash of a put row (kind-follower.ts): the same, so a held row is never sent again.
  hash: (r) => sha12(JSON.stringify(r)),
  ordered: false,
  digest: false,
  choice: 'inbox',
  rows: async () => (await listNotifications()).feed.filter(cardOk),
  watch: (soon) => onNotificationStoreWritten(soon),
}

// --- Follower ---

function isCard(v: unknown): v is NotificationRecord {
  const r = v as Partial<NotificationRecord> | null
  return !!r && typeof r === 'object' && !Array.isArray(r) && typeof r.id === 'string' && r.id.length > 0
    && typeof r.dedupKey === 'string' && typeof r.kind === 'string' && typeof r.timestamp === 'number'
}

function cardOk(r: NotificationRecord): boolean {
  try { return isCard(r) && Buffer.byteLength(JSON.stringify(r), 'utf8') <= MAX_CARD_BYTES } catch { return false }
}

const copy = createFileCopy<NotificationRecord>({
  kind: 'notifications',
  schemaVersion: NOTIFICATIONS_SCHEMA_VERSION,
  label: 'notifications copy',
  removalFloor: NOTIFICATIONS_REMOVAL_FLOOR,
  isRow: isCard,
  key: (r) => r.id,
  admit: cardOk,
})

export const notificationsFollower = copy.follower

/**
 * The Mac's cards (oldest first, as the store keeps them) and when they were the Mac's,
 * where this server keeps the copy and holds it; null anywhere else and before the first
 * round (an older Mac), so the caller falls back to what it has.
 */
export async function readNotificationsCopy(): Promise<{ feed: NotificationRecord[]; asOf: number } | null> {
  if (!keepsCopies('notifications')) return null
  const asOf = await copyKindAsOf('notifications')
  if (asOf === null) return null
  const rows = await copy.read()
  if (!rows) return null
  const at = (r: NotificationRecord): number => r.lastTimestamp ?? r.timestamp
  return { feed: Object.values(rows).sort((a, b) => at(a) - at(b)), asOf }
}

/** Tests only. */
export function _resetNotificationsCopyForTesting(): void {
  copy.reset()
}
