/**
 * The ONE quiet gate for a push to the person's phone. Every sender (a letter, a thread, an
 * approval, the general notifications) asks `holdPushForQuiet` once it would deliver (after its
 * own device choice), and tests/core/notifications/notice-audience.test.ts fails on a sender
 * that skips it or reads quiet itself.
 *
 * While quiet holds (a focus block, macOS Focus mirrored by Rhythm, the person's own toggle)
 * NO push goes out, asks included: what needs the person waits in the inbox, the bell and its
 * thread. When quiet ends, ONE push says what still waits (the item itself when it is one),
 * never one per item, and never for what was answered meanwhile (2026-11-17, the user: "why it
 * even send me notification even I am in focus mode"). What is held is kept on disk
 * (machine-local), so a restart in the middle of a focus block, a deploy, loses none of it.
 * The web app's notices outside the window follow the same rule
 * (web/src/contexts/notifications/system-notice.ts).
 */
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { getConfig } from '../config-manager.js'
import { log } from '../../logging/index.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { getQuiet, logQuietSkipOnce, onQuietChanged, quietSuppresses, type QuietState } from '../quiet/quiet-state.js'
import { isFollower } from '../server-role.js'
import { deliverPush } from './deliver.js'
import { doorsClosed, holdUntilDoorsOpen, leaderPermitActive, outwardDoorRefusal } from '../leader/switch/doors.js'
import { ACTIVE_LEASE_MS, parseMode, selectDevices } from './letter-push-policy.js'

export interface HeldPush {
  /** `approval:<id>`, `letter:<id>`, `thread:<id>`, `push:<title>`. One per key. */
  key: string
  title: string
  /** Held because this server could not send (no write permission), not for quiet. */
  doors?: true
}

/** The reasons a sender reports for a held push. */
export const QUIET_HELD = 'quiet mode is on'
export const DOORS_HELD = 'held: this server is not the leader now, it goes out once it may send'
const DOORS_RELEASE_KEY = 'push-quiet-hold'

/** At most this many items are remembered; the count still says how many waited. */
const MAX_HELD = 50

const held = new Map<string, HeldPush>()
let heldCount = 0
let listening = false
let loaded: Promise<void> | null = null
let writeChain: Promise<void> = Promise.resolve()

function heldFile(): string {
  // `local/` is this machine's own (git-sync never carries it): a held push is this box's to send.
  return path.join(WALNUT_HOME, 'local', 'quiet-held-push.json')
}

function persist(): Promise<void> {
  const body = { version: 1, count: heldCount, items: [...held.values()] }
  writeChain = writeChain.then(() => writeJsonFile(heldFile(), body)).catch((err) => {
    log.notif.warn('push: could not keep what quiet holds', { error: err instanceof Error ? err.message : String(err) })
  })
  return writeChain
}

function ensureLoaded(): Promise<void> {
  loaded ??= (async () => {
    const raw = await readJsonFile<{ count?: unknown; items?: unknown } | null>(heldFile(), null).catch(() => null)
    for (const one of Array.isArray(raw?.items) ? raw.items : []) {
      const o = one as Record<string, unknown>
      if (typeof o?.key === 'string' && typeof o.title === 'string' && !held.has(o.key)) {
        held.set(o.key, { key: o.key, title: o.title, ...(o.doors === true ? { doors: true as const } : {}) })
      }
    }
    heldCount = Math.max(held.size, typeof raw?.count === 'number' ? raw.count : 0)
  })()
  return loaded
}

/** The words of the one push after quiet. */
export function catchUpPush(items: readonly HeldPush[], count = items.length): { title: string; body: string } | null {
  if (count === 0 || items.length === 0) return null
  if (count === 1) {
    return { title: items[0]!.title, body: items[0]!.doors ? 'It waited while Walnut could not notify you.' : 'It waited while you were focusing.' }
  }
  const titles = items.slice(0, 2).map((i) => i.title)
  const more = count > 2 ? `, and ${count - 2} more` : ''
  return { title: `${count} things waited for you`, body: `${titles.join('; ')}${more}.` }
}

/** Does this still wait on the person? An approval answered or a letter read meanwhile does not. */
async function stillWaiting(key: string): Promise<boolean> {
  try {
    if (key.startsWith('approval:')) {
      const { getApproval } = await import('../approvals/store.js')
      return (await getApproval(key.slice('approval:'.length)))?.status === 'pending'
    }
    if (key.startsWith('letter:')) {
      const { getLetter } = await import('../human-inbox/store.js')
      const letter = await getLetter(key.slice('letter:'.length), { deferBodies: true })
      return !!letter && !letter.read
    }
  } catch { /* unreadable: say it, rather than lose it */ }
  return true
}

async function releaseHeld(): Promise<void> {
  await ensureLoaded()
  // Quiet came back before this ran (a focus block right after another): keep holding.
  if ((await getQuiet()).active) return
  // The outward door BEFORE the held items are cleared: a machine without the write permission
  // keeps them, and the release runs again when the permission arrives.
  if (leaderPermitActive() && outwardDoorRefusal('push', 'walnut-quiet-catchup')) {
    releaseWhenDoorsOpen()
    return
  }
  const items = [...held.values()]
  const lost = Math.max(0, heldCount - items.length)
  held.clear()
  heldCount = 0
  await persist()
  if (isFollower()) return
  const waiting: HeldPush[] = []
  for (const item of items) if (await stillWaiting(item.key)) waiting.push(item)
  const words = catchUpPush(waiting, waiting.length + lost)
  if (!words) return
  const tokens = (await getConfig()).push_tokens ?? []
  // The person's own device settings decide, as for a decision letter; a phone in front gets none.
  const chosen = selectDevices(tokens.map((t) => ({
    entry: t, mode: parseMode(t.mode),
    ...(t.key_name ? { name: t.key_name } : {}),
    ...(typeof t.active_at === 'number' ? { activeAt: t.active_at } : {}),
    ...(t.letter_types ? { types: t.letter_types } : {}),
  })), 'action_required', Date.now(), ACTIVE_LEASE_MS)
  if (chosen.length === 0) return
  const out = await deliverPush(chosen.map(({ device }) => device.entry), { ...words, priority: 10, collapseId: 'walnut-quiet-catchup' })
  log.notif.info('push: the one reminder after quiet', { items: waiting.length, sent: out.sent, failed: out.failed, reason: out.reason })
}

/** The held items go out (one push) the moment this machine gets the write permission. */
function releaseWhenDoorsOpen(say?: () => void): void {
  holdUntilDoorsOpen(DOORS_RELEASE_KEY, () => {
    if (held.size > 0 || heldCount > 0) release()
  }, say)
}

function release(): void {
  void releaseHeld().catch((err) => {
    log.notif.warn('push: the reminder after quiet failed', { error: err instanceof Error ? err.message : String(err) })
  })
}

/** Server boot: follow quiet from the start, and send what a restart left held once it is off. */
export function initQuietHold(): void {
  if (listening) return
  listening = true
  onQuietChanged('push-quiet-hold', (state: QuietState) => {
    if (!state.active && (held.size > 0 || heldCount > 0)) release()
  })
  void ensureLoaded().then(async () => {
    if ((held.size > 0 || heldCount > 0) && !(await getQuiet()).active) release()
  }).catch(() => { /* nothing kept */ })
}

/**
 * The reason this push is held (the sender sends nothing now; the one reminder after the hold
 * covers it), or null when it may go. Quiet holds it; so does a server that may not send now
 * (no write permission: a restart waiting for its earlier permission to run out), whose held
 * items go out once it may. `channel` names the sender in the one log line per set of holds.
 */
export async function holdPushForQuiet(channel: string, item: HeldPush, about: { taskId?: string | null } = {}): Promise<string | null> {
  const quiet = await getQuiet()
  if (!quiet.active) {
    if (!doorsClosed()) return null
    await keep({ ...item, doors: true })
    // One log line per period of closed doors.
    releaseWhenDoorsOpen(() => log.notif.info('push: held while this server is not the leader', { channel }))
    return DOORS_HELD
  }
  // A hold that names tasks (a focus block on one task, a focus space) lets a push about one of
  // them through; every other hold still holds it.
  if (about.taskId && quiet.holds.some((h) => h.scope)) {
    const { scopeTaskLookup } = await import('../task-manager.js')
    if (!quietSuppresses(quiet, { taskId: about.taskId, lookup: await scopeTaskLookup() })) return null
  }
  logQuietSkipOnce(channel, quiet)
  await keep(item)
  initQuietHold()
  return QUIET_HELD
}

async function keep(item: HeldPush): Promise<void> {
  await ensureLoaded()
  if (!held.has(item.key)) heldCount++
  if (held.size < MAX_HELD || held.has(item.key)) held.set(item.key, item)
  await persist()
}

/** Tests: what quiet holds now. */
export function heldPushes(): { items: HeldPush[]; count: number } {
  return { items: [...held.values()], count: heldCount }
}

/** Tests and server teardown: forget the in-memory state (the file stays for the next start). */
export function resetQuietHold(): void {
  held.clear()
  heldCount = 0
  loaded = null
  // A test's bus.clear() drops the subscription: the next init subscribes again.
  listening = false
}
