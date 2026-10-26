/**
 * The two file areas a plugin gets beside its machine-local `plugin-data/<id>/`
 * (plugin-storage.ts):
 *
 *   - `walnut.storage.files`: `WALNUT_HOME/plugin-files/<id>/`, small TEXT files that
 *     ride the data folder's automatic git (git-sync.ts) to every box and to the
 *     backup. For what a person would want back on a new machine: a review a plugin
 *     wrote, a rules file, a settings export.
 *   - `walnut.storage.tmp`: `WALNUT_HOME/tmp/plugins/<id>/`, never in git, and every
 *     file older than the plugin's TTL is removed. For scratch and intermediate results.
 *
 * Both are declared in the manifest (`"storage": { "files": true, "tmp": true }`); an
 * undeclared area throws on use, so a person can tell from the manifest which plugins
 * write into their synced data.
 *
 * The synced area must never turn the data repo back into the commit firehose its
 * .gitignore remembers (1,958 commits a day, a 15 GB .git, a 613 MB model file
 * committed by the 30s auto-save). So:
 *
 *   - text only: a short list of extensions, strings without NUL; git itself tracks
 *     only those extensions under plugin-files/ (the whitelist in git-sync.ts);
 *   - capped: 1 MiB a file, 1,000 files, and a total per plugin (5 MiB unless the
 *     manifest asks for up to 20 MiB);
 *   - coalesced: a write lands in `plugin-data/.pending-files/<id>/` at once (local,
 *     never in git, so it survives a crash) and is published into plugin-files/ at
 *     most once every five minutes, when the plugin stops, and at the next start
 *     after a crash; a plugin's own flush() is held to once a minute. A plugin that
 *     rewrites a file every second costs one commit per five minutes, not one per 30s tick.
 *     Reads see the pending copy, so a plugin always reads back what it wrote.
 *   - primary only: on a replica the area is read-only, and git-sync never stages it
 *     there, so two boxes never fight over one file.
 */

import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { CLOUD_MODE, TMP_DIR, WALNUT_HOME } from '../../constants.js'
import { createSubsystemLogger } from '../../logging/subsystem.js'
import type { PluginStorageDeclaration } from '../integration-types.js'
import type { Disposable } from './disposable.js'
import { SYNCED_FILE_EXTENSIONS, SYNCED_FILE_MAX_BYTES, SYNCED_FILES_DIR, SYNCED_REFUSED_FOLDERS } from './plugin-file-rules.js'
import { PluginStorage } from './plugin-storage.js'

export { SYNCED_FILE_EXTENSIONS, SYNCED_FILE_MAX_BYTES }
/** A plugin's synced area in all, unless its manifest asks for more. */
export const SYNCED_AREA_DEFAULT_BYTES = 5 * 1024 * 1024
/** The most a manifest may ask for. */
export const SYNCED_AREA_MAX_BYTES = 20 * 1024 * 1024
/** Files in one plugin's synced area: empty files cost no bytes, so the count has a cap of its own. */
export const SYNCED_AREA_MAX_FILES = 1_000
/** Pending writes are published at most this often. */
export const SYNCED_PUBLISH_INTERVAL_MS = 5 * 60_000
/** Scratch lives this long unless the manifest says otherwise. */
export const TMP_DEFAULT_TTL_HOURS = 24
/** The longest TTL a manifest may ask for; also how old an orphan of an uninstalled plugin gets. */
export const TMP_MAX_TTL_HOURS = 30 * 24
/** A first write waits this long, so a burst of writes is published as one change. */
export const SYNCED_PUBLISH_MIN_DELAY_MS = 10_000
/** A plugin's own flush() publishes at most this often; one sooner is held until then. */
export const SYNCED_FLUSH_MIN_GAP_MS = 60_000
/** Files one walk reads; above the area's file cap, so a full area is always read whole. */
const WALK_LIMIT = 2 * SYNCED_AREA_MAX_FILES
const TMP_SWEEP_INTERVAL_MS = 60 * 60_000
const log = createSubsystemLogger('plugin-files')

export type { PluginStorageDeclaration }

/**
 * The manifest's `storage` block, leniently: a bad entry costs that area (with a reason
 * the caller logs), never the plugin; a bad number keeps the area with its default.
 * `true` or `{}` takes the defaults; numbers are clamped later by syncedAreaCap / tmpTtlMs.
 */
export function parseStorageDeclaration(raw: unknown): { storage?: PluginStorageDeclaration; dropped: string[] } {
  const dropped: string[] = []
  if (raw === undefined) return { dropped }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { dropped: ['storage must be an object like { "files": true, "tmp": true }'] }
  const obj = raw as Record<string, unknown>
  const storage: PluginStorageDeclaration = {}
  const area = <K extends 'maxBytes' | 'ttlHours'>(key: 'files' | 'tmp', field: K): boolean | Record<K, number> | undefined => {
    const value = obj[key]
    if (value === undefined || value === false) return undefined
    if (value === true) return true
    if (!value || typeof value !== 'object' || Array.isArray(value)) { dropped.push(`storage.${key} must be true or an object`); return undefined }
    const n = (value as Record<string, unknown>)[field]
    if (n === undefined) return true
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) { dropped.push(`storage.${key}.${field} must be a positive number`); return true }
    return { [field]: n } as Record<K, number>
  }
  const files = area('files', 'maxBytes')
  const tmp = area('tmp', 'ttlHours')
  if (files !== undefined) storage.files = files
  if (tmp !== undefined) storage.tmp = tmp
  for (const key of Object.keys(obj)) if (key !== 'files' && key !== 'tmp') dropped.push(`storage.${key} is not an area this Walnut knows`)
  return { storage: storage.files !== undefined || storage.tmp !== undefined ? storage : undefined, dropped }
}

export function syncedFilesRoot(pluginId: string, home = WALNUT_HOME): string {
  return path.join(home, SYNCED_FILES_DIR, pluginId)
}

/** Outside the plugin's own data dir, so `walnut.storage.list()` never shows it; `plugin-data/` is not in git. */
export function syncedPendingRoot(pluginId: string, home = WALNUT_HOME): string {
  return path.join(home, 'plugin-data', '.pending-files', pluginId)
}

export function pluginTmpRoot(pluginId: string, tmpDir = TMP_DIR): string {
  return path.join(tmpDir, 'plugins', pluginId)
}

/** The area cap a declaration asks for, clamped; null when the area is not declared. */
export function syncedAreaCap(declaration: PluginStorageDeclaration | undefined): number | null {
  const files = declaration?.files
  if (!files) return null
  const asked = typeof files === 'object' && typeof files.maxBytes === 'number' && files.maxBytes > 0 ? files.maxBytes : SYNCED_AREA_DEFAULT_BYTES
  return Math.min(Math.floor(asked), SYNCED_AREA_MAX_BYTES)
}

/** The TTL a declaration asks for in milliseconds, clamped; null when the area is not declared. */
export function tmpTtlMs(declaration: PluginStorageDeclaration | undefined): number | null {
  const tmp = declaration?.tmp
  if (!tmp) return null
  const asked = typeof tmp === 'object' && typeof tmp.ttlHours === 'number' && tmp.ttlHours > 0 ? tmp.ttlHours : TMP_DEFAULT_TTL_HOURS
  return Math.min(asked, TMP_MAX_TTL_HOURS) * 3_600_000
}

function safeName(name: string): string {
  const normalized = String(name ?? '').trim().replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.includes('\0')) {
    throw new Error(`Invalid plugin file path: ${JSON.stringify(name)}`)
  }
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment.startsWith('.'))) {
    throw new Error(`Invalid plugin file path: ${JSON.stringify(name)} (no "..", and no hidden names)`)
  }
  return segments.join('/')
}

async function walk(root: string, limit = WALK_LIMIT): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
  const out: Array<{ name: string; size: number; mtimeMs: number }> = []
  const queue = [root]
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift()!
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile() && !entry.name.startsWith('.open-walnut-')) {
        const stat = await fs.stat(absolute).catch(() => null)
        if (stat) out.push({ name: path.relative(root, absolute).replace(/\\/g, '/'), size: stat.size, mtimeMs: stat.mtimeMs })
      }
    }
  }
  return out
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.open-walnut-${createHash('sha1').update(`${file}${Math.random()}`).digest('hex').slice(0, 16)}.tmp`)
  try {
    await fs.writeFile(temporary, text, 'utf8')
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function removeEmptyDirs(root: string, dir: string): Promise<void> {
  let current = dir
  while (current.startsWith(root + path.sep)) {
    const entries = await fs.readdir(current).catch(() => null)
    if (!entries || entries.length > 0) return
    await fs.rmdir(current).catch(() => undefined)
    current = path.dirname(current)
  }
}

export interface SyncedFileAreaOptions {
  pluginId: string
  /** Bytes; null = the manifest did not declare the area, and every call throws. */
  cap: number | null
  /** Where the published files live (plugin-files/<id>). */
  root?: string
  /** Where pending writes wait (plugin-data/.pending-files/<id>). */
  pendingRoot?: string
  replica?: boolean
  publishIntervalMs?: number
  minDelayMs?: number
  now?: () => number
}

/** `walnut.storage.files`. */
export class SyncedFileArea implements Disposable {
  readonly dir: string
  private readonly pendingRoot: string
  private readonly cap: number | null
  private readonly replica: boolean
  private readonly intervalMs: number
  private readonly minDelayMs: number
  private readonly now: () => number
  private sizes: Map<string, number> | null = null
  private timer: NodeJS.Timeout | null = null
  private timerDue = 0
  private lastPublishAt = 0
  /** flush() calls held by the once-a-minute limit, resolved by the publish that follows. */
  private heldFlushes: Array<() => void> = []
  /** Writes, deletes and publishing run one at a time: the cap is checked against settled sizes, and a publish never drops a pending copy a write just replaced. */
  private chain: Promise<unknown> = Promise.resolve()
  private recovered = false
  private disposed = false

  constructor(private readonly options: SyncedFileAreaOptions) {
    this.dir = options.root ?? syncedFilesRoot(options.pluginId)
    this.pendingRoot = options.pendingRoot ?? syncedPendingRoot(options.pluginId)
    this.cap = options.cap
    this.replica = options.replica ?? CLOUD_MODE
    this.intervalMs = options.publishIntervalMs ?? SYNCED_PUBLISH_INTERVAL_MS
    this.minDelayMs = options.minDelayMs ?? SYNCED_PUBLISH_MIN_DELAY_MS
    this.now = options.now ?? Date.now
  }

  async readText(name: string): Promise<string | null> {
    const relative = this.check(name)
    await this.resume()
    return (await readOrNull(path.join(this.pendingRoot, relative))) ?? readOrNull(path.join(this.dir, relative))
  }

  async readJson<T>(name: string, fallback: T): Promise<T> {
    const text = await this.readText(name)
    if (text === null) return fallback
    return JSON.parse(text) as T
  }

  async writeText(name: string, value: string): Promise<void> {
    const relative = this.check(name, true)
    if (typeof value !== 'string') throw new TypeError('A synced plugin file holds text')
    if (value.includes('\0')) throw new TypeError('A synced plugin file holds text, not binary data')
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > SYNCED_FILE_MAX_BYTES) {
      throw new RangeError(`${relative} is ${bytes} bytes; a synced plugin file holds at most ${SYNCED_FILE_MAX_BYTES}. Keep big data in walnut.storage (machine-local).`)
    }
    await this.resume()
    await this.serial(async () => {
      const sizes = await this.loadSizes()
      if (!sizes.has(relative) && sizes.size >= SYNCED_AREA_MAX_FILES) {
        throw new RangeError(`The synced files of this plugin hold ${sizes.size} files, the most one plugin may keep there. Delete old files first.`)
      }
      const total = [...sizes].reduce((sum, [key, size]) => sum + (key === relative ? 0 : size), 0) + bytes
      if (total > this.cap!) {
        throw new RangeError(`The synced files of this plugin would hold ${total} bytes; its limit is ${this.cap}. Delete old files, or raise storage.files.maxBytes (at most ${SYNCED_AREA_MAX_BYTES}).`)
      }
      await writeAtomic(path.join(this.pendingRoot, relative), value)
      sizes.set(relative, bytes)
    })
    this.schedule()
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.writeText(name, `${JSON.stringify(value, null, 2)}\n`)
  }

  /** Deletes at once (a delete is one change), the pending copy and the published one. */
  async delete(name: string): Promise<void> {
    const relative = this.check(name, true)
    await this.resume()
    await this.serial(async () => {
      await fs.rm(path.join(this.pendingRoot, relative), { force: true })
      await fs.rm(path.join(this.dir, relative), { force: true })
      await removeEmptyDirs(this.pendingRoot, path.dirname(path.join(this.pendingRoot, relative)))
      await removeEmptyDirs(this.dir, path.dirname(path.join(this.dir, relative)))
      ;(await this.loadSizes()).delete(relative)
    })
  }

  async list(prefix = ''): Promise<string[]> {
    this.check()
    await this.resume()
    const names = new Set<string>()
    for (const root of [this.dir, this.pendingRoot]) for (const file of await walk(root)) names.add(file.name)
    const clean = prefix ? safeName(prefix) : ''
    return [...names].filter((name) => !clean || name === clean || name.startsWith(`${clean}/`)).sort()
  }

  /**
   * Publish the pending writes now, so the next auto-save commits them: for a plugin that
   * wants a file out at once. At most once a minute; a flush sooner than that is held until
   * the minute is up (and resolves then), so a plugin that flushes after every write still
   * costs one commit a minute at most. It resolves once the publish ran, also when that
   * publish failed: what failed stays pending and goes out with a later one.
   */
  async flush(): Promise<void> {
    if (this.cap === null || this.replica) return
    // Capped, so a clock set back never holds a flush longer than the gap.
    const wait = Math.min(SYNCED_FLUSH_MIN_GAP_MS, this.lastPublishAt + SYNCED_FLUSH_MIN_GAP_MS - this.now())
    if (wait > 0 && !this.disposed) {
      await new Promise<void>((resolve) => {
        this.heldFlushes.push(resolve)
        this.schedule(wait)
      })
      return
    }
    await this.publish()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.publish()
  }

  /** Move every pending write into the published folder. The timer, a flush and dispose run it. */
  private async publish(): Promise<void> {
    // A replica only reads what git brought; an undeclared area has nothing to publish.
    if (this.cap === null || this.replica) return
    const held = this.heldFlushes.splice(0)
    let again = false
    try {
      await this.serial(async () => {
        try {
          const pending = await walk(this.pendingRoot)
          for (const file of pending) {
            const from = path.join(this.pendingRoot, file.name)
            const text = await readOrNull(from)
            if (text === null) continue
            await writeAtomic(path.join(this.dir, file.name), text)
            await fs.rm(from, { force: true })
            await removeEmptyDirs(this.pendingRoot, path.dirname(from))
          }
          if (pending.length > 0) this.lastPublishAt = this.now()
          // A walk stops at its limit: what it did not reach goes with the next publish.
          again = pending.length >= WALK_LIMIT
        } catch (error) {
          // Left pending, and tried again after the usual interval.
          this.lastPublishAt = this.now()
          again = true
          log.warn('Synced plugin files not published', { pluginId: this.options.pluginId, error: error instanceof Error ? error.message : String(error) })
        }
      })
    } finally {
      for (const resolve of held) resolve()
    }
    if (again) this.schedule()
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Arm the publish timer: after `soonerMs` when given (a held flush), else after the usual delay. A timer already set for sooner stays. */
  private schedule(soonerMs?: number): void {
    if (this.disposed) return
    const delay = soonerMs ?? Math.min(this.intervalMs, Math.max(this.minDelayMs, this.lastPublishAt + this.intervalMs - this.now()))
    const due = this.now() + delay
    if (this.timer && this.timerDue <= due) return
    if (this.timer) clearTimeout(this.timer)
    this.timerDue = due
    this.timer = setTimeout(() => {
      this.timer = null
      void this.publish()
    }, delay)
    this.timer.unref?.()
  }

  /** Writes a crash (or a stop without a clean dispose) left pending: publish them soon. Run at activation and on first use. */
  async resume(): Promise<void> {
    if (this.recovered || this.replica || this.cap === null) return
    this.recovered = true
    try {
      if ((await walk(this.pendingRoot, 1)).length > 0) this.schedule()
    } catch (error) {
      log.warn('Pending synced plugin files not read', { pluginId: this.options.pluginId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async loadSizes(): Promise<Map<string, number>> {
    if (this.sizes) return this.sizes
    const sizes = new Map<string, number>()
    for (const file of await walk(this.dir)) sizes.set(file.name, file.size)
    for (const file of await walk(this.pendingRoot)) sizes.set(file.name, file.size)
    this.sizes = sizes
    return sizes
  }

  private check(name?: string, write = false): string {
    if (this.disposed) throw new Error('Plugin storage is closed')
    if (this.cap === null) {
      throw new Error('This plugin has no synced files area: declare "storage": { "files": true } in manifest.json')
    }
    if (write && this.replica) {
      throw new Error('Synced plugin files are read-only on a replica; the primary Walnut writes them')
    }
    if (name === undefined) return ''
    const relative = safeName(name)
    // Any case: git on a Mac ignores case, so `Node_Modules/` would be ignored there too.
    if (relative.split('/').slice(0, -1).some((segment) => (SYNCED_REFUSED_FOLDERS as readonly string[]).includes(segment.toLowerCase()))) {
      throw new Error(`Invalid plugin file path: ${JSON.stringify(name)} (git never syncs a ${SYNCED_REFUSED_FOLDERS.join(' or ')} folder)`)
    }
    // Lower case only: git's whitelist (git-sync.ts) matches case-sensitively on Linux.
    const extension = path.extname(relative)
    if (!(SYNCED_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
      throw new TypeError(`${relative}: a synced plugin file is text with a lower-case extension, one of ${SYNCED_FILE_EXTENSIONS.join(' ')}`)
    }
    return relative
  }
}

export interface TmpFileAreaOptions {
  pluginId: string
  /** Milliseconds; null = the manifest did not declare the area, and every call throws. */
  ttlMs: number | null
  root?: string
  now?: () => number
}

/** `walnut.storage.tmp`: scratch, never in git, swept after the TTL. */
export class TmpFileArea implements Disposable {
  readonly dir: string
  private readonly files: PluginStorage
  private readonly ttlMs: number | null
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly options: TmpFileAreaOptions) {
    this.dir = options.root ?? pluginTmpRoot(options.pluginId)
    this.files = new PluginStorage(this.dir)
    this.ttlMs = options.ttlMs
    this.now = options.now ?? Date.now
    // Swept from the start, so scratch a plugin never touches again still expires.
    if (this.ttlMs !== null) this.arm()
  }

  async readText(name: string): Promise<string | null> { this.check(); return this.files.readText(name) }
  async readJson<T>(name: string, fallback: T): Promise<T> { this.check(); return this.files.readJson(name, fallback) }
  async writeText(name: string, value: string): Promise<void> { this.check(); await this.files.writeText(name, value) }
  async writeJson(name: string, value: unknown): Promise<void> { this.check(); await this.files.writeJson(name, value) }
  async delete(name: string): Promise<void> { this.check(); return this.files.delete(name) }
  async list(prefix?: string): Promise<string[]> { this.check(); return this.files.list(prefix) }

  /** Remove every file older than the TTL, and the folders that leaves empty. */
  async sweep(): Promise<number> {
    if (this.ttlMs === null) return 0
    return sweepOlderThan(this.dir, this.ttlMs, this.now())
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.files.dispose()
  }

  /** Sweep once now, then hourly. */
  private arm(): void {
    if (this.timer || this.disposed) return
    void this.sweep().catch(() => undefined)
    this.timer = setInterval(() => { void this.sweep().catch(() => undefined) }, TMP_SWEEP_INTERVAL_MS)
    this.timer.unref?.()
  }

  private check(): void {
    if (this.disposed) throw new Error('Plugin storage is closed')
    if (this.ttlMs === null) throw new Error('This plugin has no tmp area: declare "storage": { "tmp": true } in manifest.json')
  }
}

/** Remove files under `root` last changed more than `ageMs` ago. Never throws. */
export async function sweepOlderThan(root: string, ageMs: number, nowMs = Date.now()): Promise<number> {
  let removed = 0
  try {
    for (const file of await walk(root, 20_000)) {
      if (nowMs - file.mtimeMs <= ageMs) continue
      const absolute = path.join(root, file.name)
      await fs.rm(absolute, { force: true }).catch(() => undefined)
      await removeEmptyDirs(root, path.dirname(absolute))
      removed++
    }
  } catch (error) {
    log.warn('Plugin tmp sweep failed', { root, error: error instanceof Error ? error.message : String(error) })
  }
  return removed
}

/**
 * Boot: scratch of every plugin, installed or not, older than the longest TTL a
 * manifest may ask for. A running plugin sweeps its own folder with its own TTL.
 */
export function sweepPluginTmpOrphans(tmpDir = TMP_DIR, nowMs = Date.now()): Promise<number> {
  return sweepOlderThan(path.join(tmpDir, 'plugins'), TMP_MAX_TTL_HOURS * 3_600_000, nowMs)
}
