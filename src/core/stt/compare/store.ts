/**
 * The comparison store: one JSON per take at
 * <WALNUT_HOME>/stt-compare/takes/<takeId>.json, written atomically (tmp +
 * rename). Machine-local like the recordings it points at (never synced). At
 * most MAX_TAKES are kept; past that the entry touched longest ago goes (its
 * audio is the recording stores' business, never touched here). The entry just
 * written is never the one that goes.
 *
 * This process is the only writer, so the entries are held in memory after the
 * first read; every write goes through one queue per store.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AudioRef, CompareTake, EngineResult } from './types.js'

export const MAX_TAKES = 500
const TAKE_ID = /^(rec|phone)-[0-9A-Za-z-]{1,80}$/

export function validTakeId(id: unknown): id is string {
  return typeof id === 'string' && TAKE_ID.test(id)
}

/** The take id of a recording in either store. */
export function takeIdOf(ref: AudioRef): string {
  return `${ref.kind === 'archive' ? 'phone' : 'rec'}-${ref.id}`
}

export type TakePatch = Partial<Omit<CompareTake, 'id' | 'results'>> & { results?: Record<string, EngineResult | undefined> }

async function defaultDir(): Promise<string> {
  const { WALNUT_HOME } = await import('../../../constants.js')
  return join(WALNUT_HOME, 'stt-compare', 'takes')
}

export class CompareStore {
  private takes: Map<string, CompareTake> | null = null
  private loading: Promise<Map<string, CompareTake>> | null = null
  private writing: Promise<unknown> = Promise.resolve()

  constructor(private readonly dirOf: () => Promise<string> = defaultDir) {}

  private load(): Promise<Map<string, CompareTake>> {
    if (this.takes) return Promise.resolve(this.takes)
    this.loading ??= (async () => {
      const dir = await this.dirOf()
      const map = new Map<string, CompareTake>()
      for (const file of await readdir(dir).catch(() => [] as string[])) {
        if (!file.endsWith('.json')) continue
        const id = file.slice(0, -5)
        if (!validTakeId(id)) continue
        try {
          const take = JSON.parse(await readFile(join(dir, file), 'utf8')) as CompareTake
          if (take && take.id === id && take.audioRef && typeof take.at === 'string') map.set(id, { ...take, results: take.results ?? {} })
        } catch { /* an unreadable entry is skipped, never rewritten */ }
      }
      // The map's order is the touch order (oldest first): read back, the takes' own times stand in for it.
      this.takes = new Map([...map].sort((a, b) => a[1].at.localeCompare(b[1].at)))
      return this.takes
    })().finally(() => { this.loading = null })
    return this.loading
  }

  private async persist(take: CompareTake): Promise<void> {
    const dir = await this.dirOf()
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${take.id}.json`)
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(take, null, 1))
    await rename(tmp, path)
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writing.catch(() => {}).then(fn)
    this.writing = run
    return run
  }

  async get(id: string): Promise<CompareTake | null> {
    if (!validTakeId(id)) return null
    const take = (await this.load()).get(id)
    return take ? structuredClone(take) : null
  }

  async has(id: string): Promise<boolean> {
    return validTakeId(id) && (await this.load()).has(id)
  }

  async count(): Promise<number> {
    return (await this.load()).size
  }

  private async sorted(): Promise<CompareTake[]> {
    return [...(await this.load()).values()].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
  }

  /** Every entry, newest first. */
  async all(): Promise<CompareTake[]> {
    return (await this.sorted()).map((t) => structuredClone(t))
  }

  /** A page, newest first; `cursor` is the last id of the page before. Only the page is copied. */
  async list(limit = 50, cursor?: string): Promise<{ takes: CompareTake[]; nextCursor?: string }> {
    const all = await this.sorted()
    const from = cursor ? all.findIndex((t) => t.id === cursor) + 1 : 0
    const page = all.slice(from, from + Math.max(1, Math.min(limit, 200))).map((t) => structuredClone(t))
    const more = from + page.length < all.length
    return { takes: page, ...(more && page.length ? { nextCursor: page[page.length - 1]!.id } : {}) }
  }

  /**
   * Create or merge an entry. `results` merge per engine (an engine's entry
   * set to undefined is removed); every other field present replaces. A new
   * entry needs `source`, `at`, `format` and `audioRef`.
   */
  upsert(id: string, patch: TakePatch): Promise<CompareTake> {
    if (!validTakeId(id)) return Promise.reject(new Error(`invalid take id: ${id}`))
    return this.queue(async () => {
      const map = await this.load()
      const prior = map.get(id)
      if (!prior && (!patch.source || !patch.at || !patch.format || !patch.audioRef)) throw new Error(`take ${id} is new and lacks its source`)
      const { results, ...rest } = patch
      const merged: CompareTake = { ...(prior ?? { id, results: {} }), ...rest, id } as CompareTake
      merged.results = { ...(prior?.results ?? {}) }
      for (const [engine, result] of Object.entries(results ?? {})) {
        if (result === undefined) delete merged.results[engine]
        else merged.results[engine] = result
      }
      await this.persist(merged)
      // Touched: to the end of the order.
      map.delete(id)
      map.set(id, merged)
      if (!prior && map.size > MAX_TAKES) await this.dropLeastTouched(map)
      return structuredClone(merged)
    })
  }

  /** The entries touched longest ago go, until MAX_TAKES are left; the last one touched never does. */
  private async dropLeastTouched(map: Map<string, CompareTake>): Promise<void> {
    const dir = await this.dirOf()
    const over = [...map.keys()].slice(0, Math.max(0, map.size - MAX_TAKES))
    for (const id of over) {
      await rm(join(dir, `${id}.json`), { force: true })
      map.delete(id)
    }
  }

  /** Remove every entry and the store's folder (`stt-compare/`); the recordings are untouched. */
  clear(): Promise<void> {
    return this.queue(async () => {
      const dir = await this.dirOf()
      await rm(dir, { recursive: true, force: true })
      // The default store's folder is stt-compare/takes: its parent is Voice Accuracy's own.
      if (dirname(dir).endsWith('stt-compare')) await rm(dirname(dir), { recursive: true, force: true })
      this.takes = new Map()
    })
  }

  /** Test hook: read the directory again. */
  _forget(): void { this.takes = null }
}

export const compareStore = new CompareStore()
