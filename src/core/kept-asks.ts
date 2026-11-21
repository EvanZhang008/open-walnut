/**
 * Asks a person answers, kept across a Walnut restart (2026-11-20: a deploy restarted the server
 * while an agent's `walnut browser request-sign-in` waited for the person's Touch ID; the ask lived
 * in memory only, so the agent's next call with the same request id made a second card and the
 * person was asked again). Production restarts about 60 times a day, so every ask that waits on
 * a person (a sign-in, an upload, a step that buys or sends, a new site, a fill of a saved login,
 * a password an agent asked for) keeps its state here: the same id means the same ask after boot.
 *
 * `keptMap(name)` is a Map whose entries are also in `WALNUT_HOME/kept-asks/<name>.json` (0600):
 * read once, lazily, at the map's first use, and written (whole, atomically, in order) on every
 * change. A value changed in place is written with `changed()`. An older Walnut never reads the
 * folder, and a file that does not parse is read as empty. Each module still sweeps its own
 * entries by their own clocks (`at`, `expiresAt`), which are wall-clock times and hold across a
 * restart; expiry, owner checks and refusals stay where they were.
 *
 * The folder is this server's own state: never git-synced (CRITICAL_IGNORE_DIRS in
 * integrations/git-sync.ts), and no kept value holds a secret in the clear (a token is kept as
 * its hash; guard: tests/core/wait-through-restart-guard.test.ts).
 *
 * Tests: `forgetKeptForRestart()` drops every map's memory and keeps the files, as a restart
 * does; `flushKept()` waits for the writes so far. Under vitest each test file keeps its own
 * folder (testDir): test files share one test home, run side by side, and one file's asks,
 * brakes or denials must never reach another.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { writeFileAtomic } from './config-file-io.js'

const VERSION = 1
/**
 * Under vitest: this worker's pool and the test file running, so a restart within the file keeps
 * its asks and no other file reads them. A child server a test spawns and restarts shares one
 * folder by setting WALNUT_KEPT_ASKS_SHARED=1 in its environment.
 */
function testDir(): string | undefined {
  if (!process.env.VITEST || process.env.WALNUT_KEPT_ASKS_SHARED === '1') return undefined
  const file = (globalThis as { __vitest_worker__?: { filepath?: string } }).__vitest_worker__?.filepath ?? 'child'
  const pool = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
  return `test-${pool}-${crypto.createHash('sha256').update(file).digest('hex').slice(0, 12)}`
}

export interface KeptOptions<V> {
  /** What of a value goes to disk (default: the value as it is). */
  pack?: (v: V) => unknown
  /** A value read back, or undefined to drop it (default: kept as read when it is an object or a number). */
  unpack?: (raw: unknown) => V | undefined
}

export interface KeptMap<V> extends Map<string, V> {
  /** A value was changed in place: write the map again. */
  changed(): void
}

const all = new Set<KeptMapImpl<unknown>>()

export function keptDir(): string {
  const test = testDir()
  return path.join(WALNUT_HOME, 'kept-asks', ...(test ? [test] : []))
}

class KeptMapImpl<V> extends Map<string, V> implements KeptMap<V> {
  private loaded = false
  private writing: Promise<void> = Promise.resolve()
  private queued = false
  /** Bumped by forget(): a write queued before it never writes the emptied memory. */
  private gen = 0

  constructor(readonly name: string, private readonly opts: KeptOptions<V>) {
    super()
  }

  private file(): string {
    return path.join(keptDir(), `${this.name}.json`)
  }

  /** The kept entries, once per process (a small file: read before the first answer that needs it). */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
    } catch {
      return
    }
    const entries = (raw as { version?: unknown; entries?: unknown } | null)?.entries
    if (!Array.isArray(entries)) return
    for (const e of entries) {
      if (!Array.isArray(e) || typeof e[0] !== 'string') continue
      const v = this.opts.unpack ? this.opts.unpack(e[1]) : (e[1] !== null && (typeof e[1] === 'object' || typeof e[1] === 'number') ? e[1] as V : undefined)
      if (v !== undefined) super.set(e[0], v)
    }
  }

  changed(): void {
    this.load()
    // One write waits at a time and takes the newest state when it runs.
    if (this.queued) return
    this.queued = true
    const gen = this.gen
    this.writing = this.writing.then(async () => {
      if (gen !== this.gen) return
      this.queued = false
      const entries = [...super.entries()].map(([k, v]) => [k, this.opts.pack ? this.opts.pack(v) : v])
      try {
        await fs.promises.mkdir(keptDir(), { recursive: true, mode: 0o700 })
        await writeFileAtomic(this.file(), JSON.stringify({ version: VERSION, entries }), 0o600)
      } catch {
        // A full disk or a removed home: the ask still works in memory until the next write.
      }
    })
  }

  flush(): Promise<void> {
    return this.writing
  }

  /** As a restart: memory gone, the file kept. */
  forget(): void {
    super.clear()
    this.loaded = false
    this.queued = false
    this.gen++
  }

  override get(k: string): V | undefined { this.load(); return super.get(k) }
  override has(k: string): boolean { this.load(); return super.has(k) }
  override set(k: string, v: V): this { this.load(); super.set(k, v); this.changed(); return this }
  override delete(k: string): boolean {
    this.load()
    const had = super.delete(k)
    if (had) this.changed()
    return had
  }
  override clear(): void {
    this.load()
    const had = super.size > 0
    super.clear()
    if (had) this.changed()
  }
  override get size(): number { this.load(); return super.size }
  override entries(): MapIterator<[string, V]> { this.load(); return super.entries() }
  override keys(): MapIterator<string> { this.load(); return super.keys() }
  override values(): MapIterator<V> { this.load(); return super.values() }
  override forEach(fn: (v: V, k: string, m: Map<string, V>) => void, self?: unknown): void { this.load(); super.forEach(fn, self) }
  override [Symbol.iterator](): MapIterator<[string, V]> { return this.entries() }
}

/** A Map of asks kept across a restart in `kept-asks/<name>.json` (one name per map, never reused). */
export function keptMap<V>(name: string, opts: KeptOptions<V> = {}): KeptMap<V> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`kept map name "${name}": lowercase letters, digits and dashes`)
  const m = new KeptMapImpl<V>(name, opts)
  all.add(m as KeptMapImpl<unknown>)
  return m
}

/** Every write so far is on disk. */
export async function flushKept(): Promise<void> {
  await Promise.all([...all].map((m) => m.flush()))
}

/** Tests: what a restart does to every kept map (memory gone, files kept). */
export function forgetKeptForRestart(): void {
  for (const m of all) m.forget()
}
