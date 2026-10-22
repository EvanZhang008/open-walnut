/**
 * The cloud companion's own cards, carried to the Mac without git (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md).
 *
 * The box's producers (its cloud-exec sessions' permission and error cards, its
 * plugins, the overview maintainer, the chat history's cron cards, the log-error
 * bridge) write the box's own store (store.ts, `cache/companion-notifications.json`),
 * and the store reports each change (mirror.ts). This module keeps those changes
 * until the Mac took them:
 *
 *   outbox  `cache/companion-notification-outbox.json` (never git): one entry per
 *           card key, the card as it now stands and how the Mac applies it. A later
 *           change of the same card folds into the entry (coalesceCard), so a card
 *           that fired a thousand times while the Mac slept is one entry.
 *   send    `server.notifications.cards` over the primary relay, at most 50 cards a
 *           call (apply-companion-cards.ts on the Mac). The Mac keys every card by
 *           its dedupKey and keeps the box's id, so a resend after a lost answer
 *           changes nothing. An entry goes once the Mac answered for it, unless it
 *           changed meanwhile.
 *   when    300 ms after a change, when the bridge to the Mac connects, every 60 s.
 *   refused the Mac ran the batch and refused it (a 4xx): dropped, logged, so one bad
 *           card never holds the rest. An older Mac answers needs-upgrade: the
 *           entries wait for its update.
 *
 * Cloud companion only: started in server.ts beside the journal's trigger.
 */

import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { writeJsonFile } from '../../utils/fs.js'
import { isCompanion } from '../server-role.js'
import type { NotificationRecord } from './store.js'
import { setOwnCardSink, type OwnCardChange, type OwnCardMode } from './mirror.js'

export interface PendingCard {
  mode: OwnCardMode
  record: NotificationRecord
  /** Occurrences folded into this entry (a new card, a fold or a replace counts one). */
  fires: number
  /** When the entry last changed (ms). */
  at: number
}

/** One card on the wire (the relay's `cards`). */
export interface CardWire { key: string; mode: OwnCardMode; fires: number; record: NotificationRecord }

export const CARDS_BATCH = 50
/** Past this many waiting cards, the oldest go (a box away for weeks). */
export const MAX_PENDING_CARDS = 500
const SWEEP_MS = 60_000
const SOON_MS = 300
const RELAY_TIMEOUT_MS = 15_000
/** A card past this size on the wire loses its long text (the bridge's frames are shared). */
const MAX_CARD_BYTES = 16 * 1024

const outboxFile = (): string => path.join(WALNUT_HOME, 'cache', 'companion-notification-outbox.json')

const RANK: Record<OwnCardMode, number> = { state: 0, add: 1, upsert: 2, replace: 3, remove: 4 }

/**
 * Fold one change into the entry waiting for its card. The entry always carries the
 * card as it now stands; its mode is the strongest of the changes it holds, so a
 * card made and then settled while the Mac was away reaches it as a new card with
 * its settled stamp. A removal ends the entry; a card made again after one replaces
 * whatever the Mac has under the key. Pure: exported for the tests.
 */
export function coalesceCard(prev: PendingCard | undefined, change: OwnCardChange, now: number): PendingCard {
  const fired = change.mode === 'add' || change.mode === 'upsert' || change.mode === 'replace' ? 1 : 0
  if (!prev) return { mode: change.mode, record: change.record, fires: fired, at: now }
  if (change.mode === 'remove') return { mode: 'remove', record: change.record, fires: 0, at: now }
  if (prev.mode === 'remove') {
    return fired ? { mode: 'replace', record: change.record, fires: fired, at: now } : { ...prev, at: now }
  }
  const mode = RANK[change.mode] > RANK[prev.mode] ? change.mode : prev.mode
  return { mode, record: change.record, fires: prev.fires + fired, at: now }
}

let pending: Map<string, PendingCard> | null = null
/** Bumped on every change of an entry, so a send that raced a change keeps the newer one. */
const revs = new Map<string, number>()
let saving: Promise<void> = Promise.resolve()

function load(): Map<string, PendingCard> {
  if (pending) return pending
  pending = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(outboxFile(), 'utf8')) as { v?: unknown; cards?: unknown }
    if (raw?.v === 1 && raw.cards && typeof raw.cards === 'object') {
      for (const [key, e] of Object.entries(raw.cards as Record<string, PendingCard>)) {
        if (e && typeof e === 'object' && e.record && typeof e.record === 'object' && RANK[e.mode] !== undefined) pending.set(key, e)
      }
    }
  } catch { /* none yet, or unreadable: start empty (the cards stay in the box's store) */ }
  return pending
}

function save(): Promise<void> {
  const cards = Object.fromEntries(load())
  saving = saving.then(() => writeJsonFile(outboxFile(), { v: 1, cards }, { mode: 0o600 })).catch((err) => {
    log.notif.warn('companion cards: could not save the outbox', { error: err instanceof Error ? err.message : String(err) })
  })
  return saving
}

let soon: ReturnType<typeof setTimeout> | null = null
let held = false
function flushSoon(): void {
  if (soon || held) return
  soon = setTimeout(() => { soon = null; void flushCompanionCards('change') }, SOON_MS)
  soon.unref?.()
}

/** The store's sink (mirror.ts): keep each change for the Mac. */
export function noteOwnCardChanges(changes: OwnCardChange[]): void {
  if (!isCompanion()) return
  const map = load()
  const now = Date.now()
  for (const c of changes) {
    map.set(c.key, coalesceCard(map.get(c.key), c, now))
    revs.set(c.key, (revs.get(c.key) ?? 0) + 1)
  }
  if (map.size > MAX_PENDING_CARDS) {
    const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, map.size - MAX_PENDING_CARDS)
    for (const [key] of oldest) map.delete(key)
    log.notif.warn('companion cards: too many cards wait for the Mac, the oldest were dropped', { dropped: oldest.length })
  }
  void save()
  flushSoon()
}

/** A card past MAX_CARD_BYTES keeps its identity and stamps, and loses the long text. */
function wireRecord(record: NotificationRecord): NotificationRecord {
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') <= MAX_CARD_BYTES) return record
  const { input: _input, acpOptions: _options, ...rest } = record
  return { ...rest, body: rest.body?.slice(0, 2000), detail: rest.detail?.slice(0, 2000) }
}

/** The cards waiting for the Mac (removals as their own list), for the box's reads. */
export function pendingCompanionCards(): { cards: NotificationRecord[]; removed: Set<string> } {
  const cards: NotificationRecord[] = []
  const removed = new Set<string>()
  if (!isCompanion()) return { cards, removed }
  for (const [key, e] of load()) {
    if (e.mode === 'remove') removed.add(key)
    else cards.push(e.record)
  }
  return { cards, removed }
}

let flushing = false
let again = false

/** Send the waiting cards. Returns how many the Mac took. Single-flight; never throws. */
export async function flushCompanionCards(why: string): Promise<number> {
  if (!isCompanion()) return 0
  if (flushing) { again = true; return 0 }
  flushing = true
  again = false
  let took = 0
  try {
    const map = load()
    const batch = [...map.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, CARDS_BATCH)
    if (batch.length === 0) return 0
    const sentRevs = new Map(batch.map(([key]) => [key, revs.get(key) ?? 0]))
    const cards: CardWire[] = batch.map(([key, e]) => ({ key, mode: e.mode, fires: e.fires, record: wireRecord(e.record) }))
    const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js')
    const r = await callPrimaryControl('server.notifications.cards', '__server__', { cards }, RELAY_TIMEOUT_MS)
    if (!r.ok) {
      const refused = r.failure.kind === 'error' && r.failure.status < 500
      if (!refused) {
        if (why !== 'sweep') log.notif.info('companion cards: the Mac did not take the cards yet', { why, kind: r.failure.kind, cards: batch.length })
        return 0
      }
      // warn, not error: an error line becomes a card here, which would go the same way.
      log.notif.warn('companion cards: the Mac refused a batch of cards, dropped', { cards: batch.length, error: r.failure.message })
    } else {
      const refusedKeys = Array.isArray(r.result.refused) ? r.result.refused : []
      if (refusedKeys.length) log.notif.warn('companion cards: the Mac refused some cards', { refused: refusedKeys.slice(0, 10), count: refusedKeys.length })
    }
    for (const [key] of batch) {
      if ((revs.get(key) ?? 0) === sentRevs.get(key)) { map.delete(key); revs.delete(key) }
    }
    await save()
    took = batch.length
    // More than one batch waited: the next goes now. A card that changed while this
    // batch was on the wire waits for the send its own change asked for (flushSoon).
    if ([...map.keys()].some((k) => !sentRevs.has(k))) again = true
    return took
  } catch (err) {
    log.notif.warn('companion cards: sending to the Mac failed', { why, error: err instanceof Error ? err.message : String(err) })
    return 0
  } finally {
    flushing = false
    if (again && took > 0) { again = false; void flushCompanionCards('more') }
    else if (again) { again = false; flushSoon() }
  }
}

/**
 * Install the store's sink and the triggers: the bridge to the Mac connecting, the
 * 60 s sweep, and a first send once the bridge had a moment at boot. Returns the stop.
 */
export function startCompanionCards(): { stop: () => void } {
  setOwnCardSink(noteOwnCardChanges)
  const timer = setInterval(() => { if (load().size > 0) void flushCompanionCards('sweep') }, SWEEP_MS)
  timer.unref?.()
  const first = setTimeout(() => { void flushCompanionCards('boot') }, 10_000)
  first.unref?.()
  let unhook: (() => void) | null = null
  let stopped = false
  void import('../../web/ws/bridge-registry.js').then(({ addPrimaryBridgeConnectedHandler }) => {
    if (!stopped) unhook = addPrimaryBridgeConnectedHandler(() => { void flushCompanionCards('bridge-connected') })
  }).catch(() => { /* the sweep still sends */ })
  return {
    stop: () => {
      stopped = true
      setOwnCardSink(null)
      clearInterval(timer)
      clearTimeout(first)
      if (soon) { clearTimeout(soon); soon = null }
      unhook?.()
    },
  }
}

/** Tests only: no send of its own after a change (the test calls flushCompanionCards). */
export function _holdCompanionCardSendsForTesting(hold: boolean): void {
  held = hold
}

/** Tests only: the outbox's last write has landed. */
export function _companionCardsSavedForTesting(): Promise<void> {
  return saving
}

/** Tests only. */
export function _resetCompanionCardsForTesting(): void {
  pending = null
  revs.clear()
  flushing = false
  again = false
  if (soon) { clearTimeout(soon); soon = null }
}
