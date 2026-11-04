/**
 * The last good cloud device list and Tailscale summary GET /api/devices
 * answered (the user, 2026-11-04: "cache should cache for long time until the
 * real data come"). A companion that is slow or down, or a Tailscale probe
 * still cold after a restart, answers with these, marked with when they were
 * read, instead of an empty list or nothing.
 *
 * Kept in memory and at WALNUT_HOME/cache/devices-last-known.json (git sync
 * ignores cache/), so a restart keeps them too. Reads are async and happen once;
 * writes are tmp + rename, chained one after another and never awaited by a
 * request. Nothing here is a secret: names, dates and self-reported models.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { DeviceInfo } from '../device-auth.js'

export interface KeptCloudList {
  /** The companion it was read from: a list from another companion is never served. */
  origin: string
  devices: DeviceInfo[]
  caller?: string
  /** When the companion answered it (ISO). */
  at: string
}

export interface TailscaleBrief { installed: boolean; running: boolean; dnsName?: string }
export interface KeptTailscale { value: TailscaleBrief; at: string }

interface Shape { version: 1; cloud?: KeptCloudList; tailscale?: KeptTailscale }

/** A value read again with nothing new is written at most this often (its `at` moves on every read). */
const REWRITE_SAME_MS = 60_000

let state: Shape | null = null
let loading: Promise<Shape> | null = null
let writing: Promise<void> = Promise.resolve()
let lastWrittenAt = 0
let fileOverride: string | null = null
/** Bumped by every removal: a read that began before one may still list the removed device. */
let forgetGen = 0

function filePath(): string {
  return fileOverride ?? path.join(WALNUT_HOME, 'cache', 'devices-last-known.json')
}

function isDevice(v: unknown): v is DeviceInfo {
  const d = v as DeviceInfo
  return !!d && typeof d === 'object' && typeof d.name === 'string' && typeof d.createdAt === 'string'
}

function parse(raw: string): Shape {
  const p = JSON.parse(raw) as Partial<Shape>
  const out: Shape = { version: 1 }
  if (p.version !== 1) return out
  const c = p.cloud
  if (c && typeof c.origin === 'string' && typeof c.at === 'string' && Array.isArray(c.devices) && c.devices.every(isDevice)) {
    out.cloud = { origin: c.origin, devices: c.devices, at: c.at, ...(typeof c.caller === 'string' ? { caller: c.caller } : {}) }
  }
  const t = p.tailscale
  if (t && typeof t.at === 'string' && t.value && typeof t.value.installed === 'boolean' && typeof t.value.running === 'boolean') {
    out.tailscale = { at: t.at, value: { installed: t.value.installed, running: t.value.running, ...(typeof t.value.dnsName === 'string' ? { dnsName: t.value.dnsName } : {}) } }
  }
  return out
}

/** The kept values, read from disk the first time. Absent or unreadable = none kept. */
function load(): Promise<Shape> {
  if (state) return Promise.resolve(state)
  if (!loading) {
    loading = (async (): Promise<Shape> => {
      let next: Shape = { version: 1 }
      try {
        next = parse(await fsp.readFile(filePath(), 'utf-8'))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.web.warn('devices: last known list unreadable', { error: String(err) })
      }
      // Every caller awaits this before it writes, so nothing landed meanwhile.
      state = next
      return next
    })()
  }
  return loading
}

/** Write the current values behind any write still out. Failure only warns: memory stays the truth. */
function persist(): void {
  const snapshot = JSON.stringify(state ?? { version: 1 }, null, 2)
  const file = filePath()
  lastWrittenAt = Date.now()
  writing = writing.then(async () => {
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(tmp, snapshot)
      await fsp.rename(tmp, file)
    } catch (err) {
      log.web.warn('devices: last known list not saved', { error: String(err) })
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
    }
  })
}

function persistUnlessSame(before: string, after: string): void {
  if (before !== after || Date.now() - lastWrittenAt >= REWRITE_SAME_MS) persist()
}

/** Take before asking the companion; hand to keepCloudList with its answer. */
export function cloudListGeneration(): number {
  return forgetGen
}

/**
 * A list the companion just answered, to a read that began at `startedGen`. A
 * device removed since then may still be in it (the read crossed the removal),
 * so such a list is not kept: the next read keeps one.
 */
export async function keepCloudList(origin: string, devices: DeviceInfo[], caller: string | undefined, startedGen: number): Promise<void> {
  if (startedGen !== forgetGen) return
  const s = await load()
  if (startedGen !== forgetGen) return
  const before = JSON.stringify({ o: s.cloud?.origin, d: s.cloud?.devices, c: s.cloud?.caller })
  s.cloud = { origin, devices, at: new Date().toISOString(), ...(caller ? { caller } : {}) }
  persistUnlessSame(before, JSON.stringify({ o: origin, d: devices, c: caller }))
}

/** The last list this companion answered, or null. */
export async function lastCloudList(origin: string): Promise<KeptCloudList | null> {
  const s = await load()
  return s.cloud && s.cloud.origin === origin ? s.cloud : null
}

/** A device removed on the companion leaves the kept list too, so a later failed read never shows it again. */
export async function forgetCloudDevice(origin: string, name: string): Promise<void> {
  forgetGen += 1
  const s = await load()
  if (!s.cloud || s.cloud.origin !== origin || !s.cloud.devices.some((d) => d.name === name)) return
  s.cloud = { ...s.cloud, devices: s.cloud.devices.filter((d) => d.name !== name) }
  persist()
}

/** The cloud half is gone on purpose (this Mac unpaired itself): nothing to keep. */
export async function dropCloudList(): Promise<void> {
  const s = await load()
  if (!s.cloud) return
  delete s.cloud
  persist()
}

/** A summary a Tailscale probe just gave. */
export async function keepTailscale(value: TailscaleBrief): Promise<void> {
  const s = await load()
  const before = JSON.stringify(s.tailscale?.value ?? null)
  s.tailscale = { value, at: new Date().toISOString() }
  persistUnlessSame(before, JSON.stringify(value))
}

export async function lastTailscale(): Promise<KeptTailscale | null> {
  return (await load()).tailscale ?? null
}

/** Tests: wait for the writes still out. */
export function flushDevicesLastKnown(): Promise<void> {
  return writing
}

/** Tests: forget the in-memory copy (as a restart does); `file` points the store elsewhere. */
export function _resetDevicesLastKnownForTesting(opts: { file?: string | null } = {}): void {
  state = null
  loading = null
  lastWrittenAt = 0
  if (opts.file !== undefined) fileOverride = opts.file
}
