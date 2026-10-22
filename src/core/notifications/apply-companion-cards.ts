/**
 * The Mac's side of the cloud companion's own cards (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md): the `server.notifications.cards`
 * relay action applies them to this Mac's feed (companion-cards.ts sends them).
 *
 * Every card is keyed by its dedupKey and keeps the id the box gave it, and every
 * mode is safe to apply twice (a resend after a lost answer):
 *
 *   add      inserted unless the Mac has a card under the key (first write wins)
 *   upsert   inserted when absent; folded in when its latest occurrence is newer
 *            than the Mac's (count + the occurrences the box folded, unread again,
 *            its settled stamp follows); an occurrence the Mac already has only
 *            carries its settled stamp
 *   replace  the Mac's card under the key goes and the box's takes its place; the
 *            same card again (same id) only carries its settled stamp
 *   state    a settled stamp (resolved, expired, recovered) on the Mac's card when
 *            it still has one and has seen no newer occurrence; a card the human
 *            dismissed on the Mac stays dismissed
 *   remove   the Mac's copy of the box's card goes (its id, or a card the box wrote)
 *
 * A card is refused alone (a letter, a key that is not its dedupKey, a shape this
 * Mac does not know, one too large), never the batch. `fix` (a repair session on
 * this Mac) is never taken from the box.
 */

import { bus, EventNames } from '../event-bus.js'
import { log } from '../../logging/index.js'
import { mutateNotificationStore, REFRESHABLE_DETAIL_KEYS, type NotificationRecord } from './store.js'
import type { OwnCardMode } from './mirror.js'

export const MAX_CARDS_PER_CALL = 100
const MAX_CARD_BYTES = 64 * 1024
const MODES = new Set<OwnCardMode>(['add', 'upsert', 'replace', 'state', 'remove'])
/** Every kind but the letter: a letter envelope mirrors this Mac's own inbox. */
const KINDS = new Set(['permission', 'cron', 'operation-error', 'skill', 'hook', 'reminder'])
const SEVERITIES = new Set(['info', 'success', 'warning', 'error'])
const RESOLVED = new Set(['allowed', 'denied', 'expired', 'recovered'])
/** The record fields a box card may carry here (NotificationRecord without `fix`). */
const FIELDS = new Set([
  'id', 'kind', 'severity', 'title', 'body', 'timestamp', 'read', 'dedupKey', 'sessionId', 'taskId',
  'resolved', 'resolvedAt', 'recoveryKey', 'causeKey', 'origin', 'category', 'detail', 'action', 'actions',
  'requestId', 'toolName', 'input', 'reason', 'acpOptions', 'host', 'sessionTitle', 'project', 'count', 'lastTimestamp',
])

interface Card { key: string; mode: OwnCardMode; fires: number; record: NotificationRecord }

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A card as this Mac stores it, or why it is refused. */
export function parseCard(raw: unknown): Card | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object'
  const c = raw as Record<string, unknown>
  if (!str(c.key, 512)) return 'no key'
  if (!MODES.has(c.mode as OwnCardMode)) return 'unknown mode'
  const r = c.record as Record<string, unknown> | undefined
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'no record'
  if (r.dedupKey !== c.key) return 'the key is not the card\'s dedupKey'
  if (!str(r.id, 128) || !KINDS.has(r.kind as string) || !SEVERITIES.has(r.severity as string)) return 'not a card'
  if (typeof r.title !== 'string' || r.title.length > 4000 || !num(r.timestamp) || typeof r.read !== 'boolean') return 'not a card'
  if (r.resolved !== undefined && !RESOLVED.has(r.resolved as string)) return 'unknown settled stamp'
  if (r.origin !== undefined && r.origin !== 'replica') return 'unknown origin'
  for (const k of ['count', 'lastTimestamp', 'resolvedAt'] as const) if (r[k] !== undefined && !num(r[k])) return `bad ${k}`
  let bytes = 0
  try { bytes = Buffer.byteLength(JSON.stringify(r), 'utf8') } catch { return 'not serializable' }
  if (bytes > MAX_CARD_BYTES) return 'too large'
  const record = Object.fromEntries(Object.entries(r).filter(([k]) => FIELDS.has(k))) as unknown as NotificationRecord
  const fires = num(c.fires) ? Math.max(0, Math.min(1_000_000, Math.floor(c.fires))) : 0
  return { key: c.key, mode: c.mode as OwnCardMode, fires, record }
}

const occurrence = (r: NotificationRecord): number => r.lastTimestamp ?? r.timestamp

type Event = { type: 'new' | 'updated' | 'removed'; record: NotificationRecord }

/** The box's settled stamp on the Mac's card, when the Mac saw no newer occurrence. */
function stamp(existing: NotificationRecord, card: NotificationRecord): boolean {
  if (!card.resolved || existing.resolved === card.resolved) return false
  if (occurrence(existing) > occurrence(card)) return false
  existing.resolved = card.resolved
  existing.resolvedAt = card.resolvedAt ?? Date.now()
  existing.severity = card.severity
  return true
}

/** One more occurrence from the box, folded the way upsertNotification folds one here. */
function fold(existing: NotificationRecord, card: NotificationRecord, fires: number): void {
  existing.title = card.title
  existing.severity = card.severity
  const into = existing as unknown as Record<string, unknown>
  const from = card as unknown as Record<string, unknown>
  for (const key of REFRESHABLE_DETAIL_KEYS) if (from[key] !== undefined) into[key] = from[key]
  if (card.causeKey !== undefined) existing.causeKey = card.causeKey
  else delete existing.causeKey
  if (card.origin) existing.origin = card.origin
  else delete existing.origin
  existing.count = (existing.count ?? 1) + Math.max(1, fires)
  existing.lastTimestamp = occurrence(card)
  existing.read = false
  if (card.resolved) { existing.resolved = card.resolved; existing.resolvedAt = card.resolvedAt ?? Date.now() }
  else { delete existing.resolved; delete existing.resolvedAt }
}

function applyOne(feed: NotificationRecord[], card: Card, events: Event[]): boolean {
  const idx = feed.findIndex((n) => n.dedupKey === card.key)
  const existing = idx === -1 ? null : feed[idx]
  const insert = (): boolean => { const r = { ...card.record }; feed.push(r); events.push({ type: 'new', record: { ...r } }); return true }
  const stamped = (): boolean => {
    if (!existing || !stamp(existing, card.record)) return false
    events.push({ type: 'updated', record: { ...existing } })
    return true
  }
  switch (card.mode) {
    case 'remove': {
      if (!existing || (existing.id !== card.record.id && existing.origin !== 'replica')) return false
      feed.splice(idx, 1)
      events.push({ type: 'removed', record: existing })
      return true
    }
    case 'add': return existing ? false : insert()
    case 'state': return stamped()
    case 'replace': {
      if (existing && existing.id === card.record.id) return stamped()
      if (existing) { feed.splice(idx, 1); events.push({ type: 'removed', record: existing }) }
      return insert()
    }
    case 'upsert': {
      if (!existing) return insert()
      if (occurrence(card.record) <= occurrence(existing)) return stamped()
      fold(existing, card.record, card.fires)
      // Tail = most recent, which is also what the cap keeps.
      feed.splice(idx, 1)
      feed.push(existing)
      events.push({ type: 'updated', record: { ...existing } })
      return true
    }
  }
}

/** Apply one relayed batch. Never throws for a bad card: it is listed in `refused`. */
export async function applyCompanionCards(raw: unknown): Promise<{ applied: number; skipped: number; refused: string[] }> {
  if (!Array.isArray(raw)) throw new TypeError('cards must be an array')
  if (raw.length > MAX_CARDS_PER_CALL) throw new RangeError(`at most ${MAX_CARDS_PER_CALL} cards a call`)
  const cards: Card[] = []
  const refused: string[] = []
  for (const c of raw) {
    const parsed = parseCard(c)
    if (typeof parsed === 'string') {
      refused.push(typeof (c as { key?: unknown })?.key === 'string' ? String((c as { key: string }).key).slice(0, 120) : '(no key)')
      continue
    }
    cards.push(parsed)
  }
  const events: Event[] = []
  let applied = 0
  if (cards.length) {
    applied = await mutateNotificationStore((store) => {
      let n = 0
      for (const card of cards) if (applyOne(store.notifications, card, events)) n++
      return n
    })
  }
  for (const e of events) {
    if (e.type === 'removed') bus.emit(EventNames.NOTIFICATION_REMOVED, { id: e.record.id, dedupKey: e.record.dedupKey }, ['web-ui'], { source: 'companion-cards' })
    else bus.emit(e.type === 'new' ? 'notification:new' : 'notification:updated', e.record, ['web-ui'], { source: 'companion-cards' })
  }
  if (applied || refused.length) log.notif.info('companion cards applied', { applied, skipped: cards.length - applied, refused: refused.length })
  return { applied, skipped: cards.length - applied, refused }
}
