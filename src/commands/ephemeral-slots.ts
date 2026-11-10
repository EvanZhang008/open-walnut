/**
 * At most WALNUT_EPHEMERAL_MAX `web --ephemeral` servers at once on this machine, a launcher
 * past that waits for one to end.
 *
 * Each test server plus its own local daemon holds about 0.3 to 1.5 GB, and on 2026-11-09 one
 * Mac ran up to three at once while its load watchdog logged 129 "MEMORY TIGHT" samples. The
 * old limit counted live control files and refused at three, so a launcher still copying its
 * snapshot was not counted and a refused agent simply tried again.
 *
 * A slot is a file `slot-<i>.json` in a per-Walnut-home dir (WALNUT_HOME/tmp, beside the
 * snapshot registry, never a temp dir swept mid-run; WALNUT_EPHEMERAL_SLOT_DIR for tests),
 * created whole with link(2), which fails when the name exists, so two launchers never take
 * the same one. It names the process holding it: the launcher, then the server it spawned.
 * A slot whose holder is gone (pid dead, or reused: start time) is free. A waiting launcher
 * keeps `wanted-<pid>.json` fresh, and a running server that sees one ends once it has been
 * idle WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES (ephemeral-idle.ts), through its own shutdown.
 *
 * Only the launcher and its child read any of this: production, the Playwright fixture on
 * :3457 (its own lease) and vitest's in-process servers never take a slot.
 */
import fs from 'node:fs'
import path from 'node:path'
import { recordedProcessGone } from './ephemeral-owner.js'
import type { LiveEphemeralServer } from './ephemeral-registry.js'

/** Two on a Mac: the 2026-11-09 data had two at once for 232 min and three for only 33. */
export const DEFAULT_EPHEMERAL_MAX_DARWIN = 2
/** Elsewhere the cap the launcher always had (a hard refusal at 3 before slots). */
export const DEFAULT_EPHEMERAL_MAX_OTHER = 3
export const DEFAULT_EPHEMERAL_WAIT_MINUTES = 30
export const SLOT_POLL_MS = 3_000
export const WAIT_REPORT_EVERY_MS = 60_000
/** A waiter touches its marker every poll; one older than this is from a waiter that stopped. */
export const WANTED_FRESH_MS = 2 * 60_000
/** Written by the launcher into the snapshot: the slot file its server holds. */
export const EPHEMERAL_SLOT_FILE = 'ephemeral-slot.json'

export type SlotHolder = {
  pid: number
  /** ps lstart of pid, '' until known (then the pid alone decides). */
  start: string
  role: 'launcher' | 'server'
  takenAt: number
  ownerPid?: number | null
  ownerCommand?: string
  port?: number
  lastRequestAt?: number
  idleLimitMinutes?: number
}
export type HeldSlot = { file: string; holder: SlotHolder }
type IsGone = (rec: { pid: number; start?: string }) => Promise<boolean>

const SLOT_RE = /^slot-(\d+)\.json$/
const WANTED_RE = /^wanted-(\d+)\.json$/

function minutesFrom(raw: string | undefined): number {
  const v = raw?.trim()
  return v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN
}

/** WALNUT_EPHEMERAL_MAX: 0 = no cap. Default 2 on macOS (11-09: memory-tight with 3 at once), 3 elsewhere. */
export function ephemeralMaxServers(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): number {
  const raw = env.WALNUT_EPHEMERAL_MAX?.trim()
  if (raw && /^\d+$/.test(raw)) return Number(raw)
  return platform === 'darwin' ? DEFAULT_EPHEMERAL_MAX_DARWIN : DEFAULT_EPHEMERAL_MAX_OTHER
}

/** WALNUT_EPHEMERAL_WAIT_MINUTES: how long a launcher waits for a slot (default 30). */
export function ephemeralWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const m = minutesFrom(env.WALNUT_EPHEMERAL_WAIT_MINUTES)
  return Math.round((m >= 0 ? Math.min(m, 24 * 60) : DEFAULT_EPHEMERAL_WAIT_MINUTES) * 60_000)
}

export function ephemeralSlotDir(walnutHome: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.WALNUT_EPHEMERAL_SLOT_DIR || path.join(walnutHome, 'tmp', 'ephemeral-slots')
}

function readHolder(file: string): { holder: SlotHolder | null; ino: number } | null {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const ino = fs.fstatSync(fd).ino
      let holder: SlotHolder | null = null
      try {
        const h = JSON.parse(fs.readFileSync(fd, 'utf-8'))
        if (h && Number.isInteger(h.pid) && h.pid > 1) holder = h as SlotHolder
      } catch { /* unreadable: no holder */ }
      return { holder, ino }
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

function tmpName(file: string, tag: string): string {
  return `${file}.${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
}

/** Create `file` whole, or fail when it exists (link never replaces a name). */
function createWhole(file: string, holder: SlotHolder): boolean {
  const tmp = tmpName(file, 'new')
  fs.writeFileSync(tmp, JSON.stringify(holder), { mode: 0o600 })
  try {
    fs.linkSync(tmp, file)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  } finally { try { fs.unlinkSync(tmp) } catch { /* gone */ } }
}

/**
 * Remove a slot judged free, only if it is still the file that was judged: moved aside first,
 * and put back when the inode shows another launcher had already freed and retaken it.
 */
function removeJudged(file: string, ino: number): void {
  const aside = tmpName(file, 'gone')
  try { fs.renameSync(file, aside) } catch { return }
  try {
    if (fs.lstatSync(aside).ino !== ino) { try { fs.linkSync(aside, file) } catch { /* taken again meanwhile */ } }
  } catch { /* gone */ }
  try { fs.unlinkSync(aside) } catch { /* gone */ }
}

/** The slots held now; a slot whose holder is gone, or that names none, is removed. */
/**
 * A running server rewrites its slot every minute (web-ephemeral.ts), so one untouched for
 * this long is a server whose loop no longer runs: it can never reach its own idle exit, and
 * would hold the slot until something killed it. Long enough for a cold boot on a loaded Mac.
 */
export const SERVER_SLOT_STALE_MS = 10 * 60_000

/** Free: no holder, a dead holder, or a server that stopped checking in. */
async function slotFree(file: string, holder: SlotHolder | null, isGone: IsGone, now: number = Date.now()): Promise<boolean> {
  if (!holder || await isGone(holder)) return true
  if (holder.role !== 'server') return false
  try { return now - fs.statSync(file).mtimeMs > SERVER_SLOT_STALE_MS } catch { return true }
}

export async function liveSlots(dir: string, isGone: IsGone = recordedProcessGone): Promise<HeldSlot[]> {
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const held: HeldSlot[] = []
  for (const name of names.filter((n) => SLOT_RE.test(n)).sort()) {
    const file = path.join(dir, name)
    const read = readHolder(file)
    if (!read) continue
    if (!(await slotFree(file, read.holder, isGone))) held.push({ file, holder: read.holder! })
    else removeJudged(file, read.ino)
  }
  return held
}

/**
 * Take a free slot, or null when `held` plus `reserved` (live servers of an older build, which
 * hold none) already reach `max`. Only indices below max - reserved are tried, so two launchers
 * racing for the last one race for the same file.
 */
export async function tryTakeSlot(dir: string, max: number, holder: SlotHolder, held: HeldSlot[], reserved = 0, isGone: IsGone = recordedProcessGone): Promise<HeldSlot | null> {
  if (held.length + reserved >= max) return null
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (let i = 0; i < max - reserved; i++) {
    const file = path.join(dir, `slot-${i}.json`)
    if (createWhole(file, holder)) return { file, holder }
    const read = readHolder(file)
    if (read && await slotFree(file, read.holder, isGone)) {
      removeJudged(file, read.ino)
      if (createWhole(file, holder)) return { file, holder }
    }
  }
  return null
}

/** Rewrite the slot only while it names `pid` (sync; the server's only writer is itself). */
export function updateSlot(file: string, pid: number, patch: Partial<SlotHolder>): boolean {
  const read = readHolder(file)
  if (!read?.holder || read.holder.pid !== pid) return false
  const tmp = tmpName(file, 'upd')
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...read.holder, ...patch }), { mode: 0o600 })
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* gone */ }
    return false
  }
}

/** Give the slot back, only if `pid` still holds it (sync: runs from the 'exit' event). */
export function releaseSlot(file: string, pid: number): void {
  const read = readHolder(file)
  if (read?.holder?.pid === pid) removeJudged(file, read.ino)
}

export function markWanted(dir: string, pid: number = process.pid): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, `wanted-${pid}.json`), JSON.stringify({ pid, at: Date.now() }), { mode: 0o600 })
  } catch { /* best-effort: the waiter still waits, servers just keep their own limit */ }
}

export function clearWanted(dir: string, pid: number = process.pid): void {
  try { fs.unlinkSync(path.join(dir, `wanted-${pid}.json`)) } catch { /* gone */ }
}

/** True when a live launcher waits for a slot: its pid alive and its marker fresh. Sync, never throws. */
export function slotWanted(dir: string, now: number = Date.now()): boolean {
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return false }
  for (const name of names) {
    const m = WANTED_RE.exec(name)
    if (!m) continue
    const file = path.join(dir, name)
    try { process.kill(Number(m[1]), 0) } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') { try { fs.unlinkSync(file) } catch { /* gone */ } }
      continue
    }
    try { if (now - fs.statSync(file).mtimeMs < WANTED_FRESH_MS) return true } catch { /* gone */ }
  }
  return false
}

/** One running server as the waiting message names it. */
export type RunningServer = { pid: number; port?: number; ownerPid?: number | null; ownerCommand?: string; since?: number; idleMinutes?: number; idleLimitMinutes?: number; starting?: boolean }

export function runningServers(held: HeldSlot[], legacy: LiveEphemeralServer[], now: number = Date.now()): RunningServer[] {
  const fromSlots = held.map(({ holder: h }) => ({
    pid: h.pid, port: h.port, ownerPid: h.ownerPid, ownerCommand: h.ownerCommand, since: h.takenAt,
    starting: h.role === 'launcher' || !h.port,
    ...(h.lastRequestAt ? { idleMinutes: (now - h.lastRequestAt) / 60_000, idleLimitMinutes: h.idleLimitMinutes } : {}),
  }))
  const fromOld = legacy.map((s) => ({ pid: s.pid, port: s.port, ownerPid: s.owner?.pid ?? null, ownerCommand: s.owner?.command, since: s.startedAt ? Date.parse(s.startedAt) : undefined }))
  return [...fromSlots, ...fromOld]
}

function serverLine(s: RunningServer, now: number): string {
  const parts = [`pid ${s.pid}`, s.starting ? 'starting' : s.port ? `port ${s.port}` : '']
  if (s.ownerPid) parts.push(`owner pid ${s.ownerPid}${s.ownerCommand ? ` (${s.ownerCommand.slice(0, 60)})` : ''}`)
  if (s.since && Number.isFinite(s.since)) parts.push(`up ${Math.max(0, Math.round((now - s.since) / 60_000))} min`)
  if (s.idleMinutes !== undefined) parts.push(`idle ${s.idleMinutes.toFixed(1)} min${s.idleLimitMinutes ? ` of ${s.idleLimitMinutes}` : ''}`)
  return `  ${parts.filter(Boolean).join(', ')}`
}

const span = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`
const serversRun = (n: number, adverb: string) => `${n} Walnut test server${n === 1 ? '' : 's'} ${adverb} run${n === 1 ? 's' : ''}`

/** Pure: what a waiting launcher prints (stderr; stdout carries only its JSON line). */
export function waitingLines(running: RunningServer[], max: number, waitMs: number, contendedMinutes: number, now: number = Date.now()): string[] {
  return [
    `ephemeral: ${serversRun(running.length, 'already')} on this machine, and at most ${max} run at once (WALNUT_EPHEMERAL_MAX=${max}). Waiting for one to end (up to ${span(waitMs)}, WALNUT_EPHEMERAL_WAIT_MINUTES).`,
    ...running.map((s) => serverLine(s, now)),
    `ephemeral: while this launcher waits, a server idle for ${contendedMinutes} min ends by itself (WALNUT_EPHEMERAL_CONTENDED_IDLE_MINUTES). Run the launcher in the background if your tool call times out sooner.`,
  ]
}

/** Pure: what a launcher that gave up prints. */
export function giveUpLines(running: RunningServer[], max: number, waitedMs: number, now: number = Date.now()): string[] {
  return [
    `ephemeral: gave up after ${span(waitedMs)}: ${serversRun(running.length, 'still')}, and at most ${max} run at once (WALNUT_EPHEMERAL_MAX=${max}).`,
    ...running.map((s) => serverLine(s, now)),
    'ephemeral: stop a server you started yourself (kill <its pid> ends it cleanly), or try again later. Raise WALNUT_EPHEMERAL_WAIT_MINUTES to wait longer, or WALNUT_EPHEMERAL_MAX only if this machine has memory to spare.',
  ]
}

export type AcquireOptions = {
  dir: string
  max: number
  holder: SlotHolder
  waitMs: number
  contendedMinutes: number
  /** Live servers from control files (ephemeral-registry.ts); those holding no slot count too. */
  liveServers: () => LiveEphemeralServer[]
  say: (line: string) => void
  /** True once the process that asked for the server is gone: nobody needs the slot any more. */
  ownerGone?: () => Promise<boolean>
  pollMs?: number
  reportEveryMs?: number
  ownerCheckEveryMs?: number
  isGone?: IsGone
}
export type AcquireResult = { slot: HeldSlot } | { slot: null; reason: 'timeout' | 'owner-gone'; running: RunningServer[] }

/** Take a slot, waiting for one when all are held; never throws for a full machine. */
export async function acquireEphemeralSlot(o: AcquireOptions): Promise<AcquireResult> {
  const pollMs = o.pollMs ?? SLOT_POLL_MS
  const reportEveryMs = o.reportEveryMs ?? WAIT_REPORT_EVERY_MS
  const started = Date.now()
  let reportedAt = 0
  let ownerCheckedAt = started
  try {
    for (;;) {
      const held = await liveSlots(o.dir, o.isGone)
      const pids = new Set(held.map((h) => h.holder.pid))
      const legacy = o.liveServers().filter((s) => !pids.has(s.pid))
      const slot = await tryTakeSlot(o.dir, o.max, { ...o.holder, takenAt: Date.now() }, held, legacy.length, o.isGone)
      if (slot) return { slot }
      const now = Date.now()
      const running = runningServers(held, legacy, now)
      if (now - started >= o.waitMs) return { slot: null, reason: 'timeout', running }
      markWanted(o.dir, o.holder.pid)
      if (reportedAt === 0 || now - reportedAt >= reportEveryMs) {
        for (const line of waitingLines(running, o.max, o.waitMs, o.contendedMinutes, now)) o.say(line)
        reportedAt = now
      }
      if (o.ownerGone && now - ownerCheckedAt >= (o.ownerCheckEveryMs ?? 30_000)) {
        ownerCheckedAt = now
        if (await o.ownerGone()) return { slot: null, reason: 'owner-gone', running }
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  } finally { clearWanted(o.dir, o.holder.pid) }
}
