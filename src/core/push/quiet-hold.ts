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
import { getQuiet, logQuietSkipOnce, onQuietChanged, type QuietState } from '../quiet/quiet-state.js'
import { isFollower } from '../server-role.js'
import { deliverPush } from './deliver.js'
import { ACTIVE_LEASE_MS, parseMode, selectDevices } from './letter-push-policy.js'

export interface HeldPush {
  /** `approval:<id>`, `letter:<id>`, `thread:<id>`, `push:<title>`. One per key. */
  key: string
  title: string
}

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
      if (typeof o?.key === 'string' && typeof o.title === 'string' && !held.has(o.key)) held.set(o.key, { key: o.key, title: o.title })
    }
    heldCount = Math.max(held.size, typeof raw?.count === 'number' ? raw.count : 0)
  })()
  return loaded
}

/** The words of the one push after quiet. */
export function catchUpPush(items: readonly HeldPush[], count = items.length): { title: string; body: string } | null {
  if (count === 0 || items.length === 0) return null
  if (count === 1) return { title: items[0]!.title, body: 'It waited while you were focusing.' }
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
 * True: quiet holds this push (the sender sends nothing now; the reminder after quiet covers it).
 * `channel` names the sender in the one log line per set of holds.
 */
export async function holdPushForQuiet(channel: string, item: HeldPush): Promise<boolean> {
  const quiet = await getQuiet()
  if (!quiet.active) return false
  await ensureLoaded()
  logQuietSkipOnce(channel, quiet)
  if (!held.has(item.key)) heldCount++
  if (held.size < MAX_HELD || held.has(item.key)) held.set(item.key, item)
  await persist()
  initQuietHold()
  return true
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
