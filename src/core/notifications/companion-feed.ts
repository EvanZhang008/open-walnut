/**
 * The cloud companion console's notification feed: the Mac owns it (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md). Used by routes/notifications.ts.
 *
 *   read   while the Mac answers, its feed over `server.notifications`, with the
 *          box's own cards that have not reached it yet on top (companion-cards.ts).
 *          While it does not, what the box has, marked `offline`: the Mac's feed from
 *          its copy (the `notifications` kind, replication/kinds/notifications.ts;
 *          before the first round, an older Mac, the data dir's notifications.json as
 *          git sync last brought it, read only) and the box's own cards (its store): one
 *          of those the Mac's feed does not name shows while it still waits for the Mac
 *          or is newer than that feed.
 *   write  mark-read and dismiss go to the Mac (`server.notifications.mark`, with the
 *          console route's exact rules, and `server.notifications.dismiss`). While it
 *          does not answer they need it (`503 needs_leader`, why
 *          `notification_changes_need_mac`): the box keeps no copy of the Mac's read
 *          state to change, and a change kept here would show reverted on the next read.
 */

import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { readJsonFile } from '../../utils/fs.js'
import { NeedsLeaderError } from '../replication/needs-leader.js'
import { listNotifications, type NotificationRecord } from './store.js'
import { pendingCompanionCards } from './companion-cards.js'

const SERVER_RELAY_SID = '__server__'
const READ_TIMEOUT_MS = 8_000
const WRITE_TIMEOUT_MS = 15_000
export const NOTIFICATION_CHANGES_NEED_MAC = 'notification_changes_need_mac'

/** The Mac answered and refused (or predates the action): the status and its words. */
export class MacRefusedError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'MacRefusedError'
  }
}

const occurrence = (r: NotificationRecord): number => r.lastTimestamp ?? r.timestamp

function isRecord(v: unknown): v is NotificationRecord {
  const r = v as Partial<NotificationRecord> | null
  return !!r && typeof r === 'object' && typeof r.dedupKey === 'string' && typeof r.id === 'string' && typeof r.timestamp === 'number'
}

function counted(feed: NotificationRecord[], offline: boolean): { feed: NotificationRecord[]; unreadCount: number; offline?: true } {
  return { feed, unreadCount: feed.filter((n) => !n.read).length, ...(offline ? { offline: true as const } : {}) }
}

/** The Mac's feed with the box's waiting cards on top: its removals gone, its new cards added. */
export function overlayWaiting(macFeed: NotificationRecord[], waiting: NotificationRecord[], removed: Set<string>): NotificationRecord[] {
  const feed = macFeed.filter((n) => !removed.has(n.dedupKey))
  const have = new Set(feed.map((n) => n.dedupKey))
  for (const card of waiting) if (!have.has(card.dedupKey)) feed.push(card)
  return feed
}

/**
 * What the box has while the Mac is away. Pure: exported for the tests.
 * `macAt` is when git sync last wrote the Mac's file (its mtime).
 */
export function awayFeed(
  mac: NotificationRecord[], macAt: number, own: NotificationRecord[], waiting: Set<string>, removed: Set<string>,
): NotificationRecord[] {
  const byKey = new Map(mac.map((n) => [n.dedupKey, { ...n }]))
  for (const n of own) {
    const m = byKey.get(n.dedupKey)
    if (m) {
      // A newer occurrence on the box is the card now; else only its settled stamp.
      if (occurrence(n) > occurrence(m)) byKey.set(n.dedupKey, { ...n })
      else if (n.resolved && !m.resolved) { m.resolved = n.resolved; m.severity = n.severity }
      continue
    }
    // Absent from the Mac's file: not there yet, or the human dismissed it on the Mac.
    if (waiting.has(n.dedupKey) || occurrence(n) > macAt) byKey.set(n.dedupKey, { ...n })
  }
  for (const k of removed) byKey.delete(k)
  return [...byKey.values()].sort((a, b) => occurrence(a) - occurrence(b))
}

/** The Mac's feed on this box: its copy once held, else the file git sync last wrote. */
async function macFeedHere(): Promise<{ feed: NotificationRecord[]; at: number; copyAsOf?: number }> {
  try {
    const { readNotificationsCopy } = await import('../replication/kinds/notifications.js')
    const copied = await readNotificationsCopy()
    if (copied) return { feed: copied.feed, at: copied.asOf, copyAsOf: copied.asOf }
  } catch (err) {
    log.notif.warn('companion feed: the notifications copy could not be read', { error: err instanceof Error ? err.message : String(err) })
  }
  // Turned off for the box (Settings): none of the Mac's cards, never the file git sync wrote.
  // The box's own cards still show, marked offline.
  if (await (await import('../replication/kinds/gate.js')).copyKindOff('notifications')) return { feed: [], at: 0 }
  return macFileFeed()
}

async function macFileFeed(): Promise<{ feed: NotificationRecord[]; at: number }> {
  const file = path.join(WALNUT_HOME, 'notifications.json')
  try {
    const raw = await readJsonFile<{ version?: unknown; notifications?: unknown } | null>(file, null)
    const feed = raw?.version === 1 && Array.isArray(raw.notifications) ? raw.notifications.filter(isRecord) : []
    return { feed, at: fs.statSync(file).mtimeMs }
  } catch {
    return { feed: [], at: 0 }
  }
}

async function relay(action: 'server.notifications' | 'server.notifications.mark' | 'server.notifications.dismiss', params: Record<string, unknown> | undefined, timeoutMs: number) {
  const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js')
  return callPrimaryControl(action, SERVER_RELAY_SID, params, timeoutMs)
}

/** The console's feed on the companion. Never throws for a Mac that does not answer. */
export async function companionFeed(): Promise<{ feed: NotificationRecord[]; unreadCount: number; offline?: true }> {
  return (await companionFeedAnswer()).answer
}

/** companionFeed, and when the Mac's part was the Mac's when it came from the copy (null: the Mac answered, or no copy). */
export async function companionFeedAnswer(): Promise<{ answer: { feed: NotificationRecord[]; unreadCount: number; offline?: true }; copyAsOf: number | null }> {
  const { cards, removed } = pendingCompanionCards()
  const r = await relay('server.notifications', undefined, READ_TIMEOUT_MS)
  if (r.ok && Array.isArray(r.result.feed)) {
    return { answer: counted(overlayWaiting(r.result.feed.filter(isRecord), cards, removed), false), copyAsOf: null }
  }
  if (!r.ok) log.notif.debug('companion feed: the Mac did not answer, answering from the box', { kind: r.failure.kind })
  return companionAwayFeed()
}

/**
 * The feed the box has while the Mac is away (see the header), and when the Mac's part of
 * it was the Mac's when that came from the copy. The phone's away feed reads it too.
 */
export async function companionAwayFeed(): Promise<{ answer: { feed: NotificationRecord[]; unreadCount: number; offline?: true }; copyAsOf: number | null }> {
  const { cards, removed } = pendingCompanionCards()
  const [mac, own] = await Promise.all([macFeedHere(), listNotifications()])
  const answer = counted(awayFeed(mac.feed, mac.at, own.feed, new Set(cards.map((c) => c.dedupKey)), removed), true)
  return { answer, copyAsOf: mac.copyAsOf ?? null }
}

type Ids = { ids?: string[]; dedupKeys?: string[] }
const named = ({ ids, dedupKeys }: Ids): Record<string, unknown> => ({ ...(ids ? { ids } : {}), ...(dedupKeys ? { dedupKeys } : {}) })

async function write<T>(action: 'server.notifications.mark' | 'server.notifications.dismiss', filter: Ids): Promise<T> {
  const r = await relay(action, named(filter), WRITE_TIMEOUT_MS)
  if (r.ok) return r.result as T
  if (r.failure.kind === 'bridge_offline') throw new NeedsLeaderError(NOTIFICATION_CHANGES_NEED_MAC)
  if (r.failure.kind === 'needs_upgrade') throw new MacRefusedError(r.failure.message, 400)
  throw new MacRefusedError(r.failure.message, r.failure.status)
}

/** Mark read on the Mac: the console route's rules (no filter = all but letters; an empty key list names nothing). */
export function companionMarkRead(filter: Ids): Promise<{ unreadCount: number }> {
  return write('server.notifications.mark', filter)
}

/** Dismiss on the Mac: no filter clears the feed, an empty list is a no-op. */
export function companionDismiss(filter: Ids): Promise<{ unreadCount: number; removed: number }> {
  return write('server.notifications.dismiss', filter)
}
