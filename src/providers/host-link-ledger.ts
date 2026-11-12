/**
 * When each host's daemon link was down, so a wait measured on the wall clock
 * can leave that time out (delivery-latency.ts), the way sleep-ledger.ts leaves
 * out the machine's sleep.
 *
 * 2026-11-11, the send.resume health alarm: two messages to clouddev sessions
 * read 65 s and 90 s "slow to wake", but the link to clouddev was down from
 * 17:25:30 to 17:28:00; once it was back, each resume took about 5 s. The
 * outage is the host link's (its own alarm and banner), not the resume path's.
 *
 * DaemonConnection.setConnected records each edge of a link that was up: down
 * opens an interval, up closes it. An open interval counts up to the moment
 * asked.
 *
 * 2026-11-12, the same alarm at 18 to 52 minutes: clouddev's SSH certificate
 * expired at 17:04 and three server restarts followed, so no process saw the
 * link fall (it was never up in them) and each one forgot what the one before
 * knew. Two more rules close that:
 *
 *  - A connection whose first connect fails was down from the moment it was
 *    made (noteHostLinkDialing, from daemon-connection.ts): a link that never
 *    came up in this process is down, not unknown. A first dial that works (its
 *    SSH, a daemon deploy) stays the delivery path's own wait.
 *  - The ledger is kept on disk (cache/, never synced) and read back at boot
 *    (loadHostLinkLedger): an interval still open when the last server stopped
 *    stays open until a link of this one comes up, so a row that waited across
 *    a restart for a host leaves all of that wait out.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

export interface DownInterval { start: number; end: number }

/** The most intervals kept per host: a flapping link drops a few hundred times a day. */
export const LINK_LEDGER_MAX = 500
/** Intervals older than this are dropped from disk: a queued row is parked after a week (MAX_PENDING_AGE_MS). */
export const LINK_LEDGER_KEEP_MS = 7 * 24 * 60 * 60_000
const closed = new Map<string, DownInterval[]>()
const open = new Map<string, number>()
/** When a link of this process first came up, per host (closing an interval read back from disk). */
const firstUpAt = new Map<string, number>()

let ledgerFile: string | null = null
let saving: Promise<void> = Promise.resolve()
/** A write is queued behind the one running: edges close together write the file once more, not once each. */
let saveQueued = false

/** The link to `host` went down at `at` (ms). A second down edge keeps the first start. */
export function noteHostLinkDown(host: string, at: number = Date.now()): void {
  if (!host || open.has(host)) return
  open.set(host, at)
  scheduleSave()
}

/**
 * A connection to `host` made at `at` failed its first connect: the link is down from `at`
 * until a link to it comes up, unless another link to that host is up (`linkUp`).
 */
export function noteHostLinkDialing(host: string, linkUp: boolean, at: number = Date.now()): void {
  if (!host || linkUp) return
  noteHostLinkDown(host, at)
}

/** The link to `host` is up again at `at` (ms). */
export function noteHostLinkUp(host: string, at: number = Date.now()): void {
  if (!firstUpAt.has(host)) firstUpAt.set(host, at)
  const start = open.get(host)
  if (start === undefined) return
  open.delete(host)
  if (at > start) addClosed(host, { start, end: at })
  scheduleSave()
}

function addClosed(host: string, d: DownInterval): void {
  const list = closed.get(host) ?? []
  list.push(d)
  list.sort((a, b) => a.start - b.start)
  if (list.length > LINK_LEDGER_MAX) list.splice(0, list.length - LINK_LEDGER_MAX)
  closed.set(host, list)
}

/** The parts of `[from, to]` (wall clock, ms) the link to `host` was down, as far as this Walnut saw. */
export function linkDownIntervals(host: string, from: number, to: number, now: number = Date.now()): DownInterval[] {
  if (!host || !(to > from)) return []
  const out: DownInterval[] = []
  const add = (s: number, e: number) => {
    const a = Math.max(from, s)
    const b = Math.min(to, e)
    if (b > a) out.push({ start: a, end: b })
  }
  for (const d of closed.get(host) ?? []) add(d.start, d.end)
  const o = open.get(host)
  if (o !== undefined) add(o, Math.max(o, now))
  return out
}

interface LedgerFile { v: 1; hosts: Record<string, { closed?: DownInterval[]; open?: number }> }

/**
 * Boot: read what earlier servers saw and keep the ledger on disk from now on. What this
 * process saw already is kept; an interval an earlier server left open joins this one's
 * open interval, or closes when this process's link first came up.
 */
export async function loadHostLinkLedger(file?: string, now: number = Date.now()): Promise<void> {
  if (!file) {
    // A test's constants mock may not name it: then the ledger stays in memory, as before.
    try { file = (await import('../constants.js')).HOST_LINK_LEDGER_FILE } catch { /* none */ }
    if (!file) return
  }
  ledgerFile = file
  let data: LedgerFile | null = null
  try {
    data = JSON.parse(await fsp.readFile(file, 'utf8')) as LedgerFile
  } catch { /* none yet, or unreadable: start empty */ }
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  for (const [host, h] of Object.entries(data?.hosts ?? {})) {
    for (const d of Array.isArray(h?.closed) ? h.closed : []) {
      if (valid(d?.start) && valid(d?.end) && d.end > d.start && d.start <= now) addClosed(host, { start: d.start, end: Math.min(d.end, now) })
    }
    if (!valid(h?.open) || h.open > now) continue
    const mine = open.get(host)
    const up = firstUpAt.get(host)
    if (mine !== undefined) open.set(host, Math.min(mine, h.open))
    // Up again in this process before the read: the earlier outage ends there.
    else if (up !== undefined && up >= h.open) addClosed(host, { start: h.open, end: up })
    // Not up in this process yet: still down until a link comes up (noteHostLinkUp closes it).
    else if (up === undefined) open.set(host, h.open)
  }
  scheduleSave()
}

/** Write the file after each edge (edges are rare: a flapping link drops a few hundred times a day). */
function scheduleSave(): void {
  if (!ledgerFile || saveQueued) return
  saveQueued = true
  void flushHostLinkLedger()
}

/** Write the ledger (each edge, and tests). Never throws. */
export function flushHostLinkLedger(now?: number): Promise<void> {
  const file = ledgerFile
  if (!file) return saving
  saving = saving.then(async () => {
    saveQueued = false
    const at = now ?? Date.now()
    const hosts: LedgerFile['hosts'] = {}
    for (const host of new Set([...closed.keys(), ...open.keys()])) {
      const kept = (closed.get(host) ?? []).filter((d) => at - d.end < LINK_LEDGER_KEEP_MS)
      const o = open.get(host)
      if (kept.length === 0 && o === undefined) continue
      hosts[host] = { ...(kept.length ? { closed: kept } : {}), ...(o !== undefined ? { open: o } : {}) }
    }
    const body = JSON.stringify({ v: 1, hosts } satisfies LedgerFile)
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(tmp, body)
      await fsp.rename(tmp, file)
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
  })
  return saving
}

/** Tests: forget every host's intervals and stop keeping the file. */
export function __resetHostLinkLedgerForTest(): void {
  closed.clear()
  open.clear()
  firstUpAt.clear()
  ledgerFile = null
  saveQueued = false
  saving = Promise.resolve()
}
