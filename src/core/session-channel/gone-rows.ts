/**
 * The own rows a host removed (a rename's old id, a drop), kept next to its fact log
 * (`session-channel/gone-<walnutId>.json`), so it survives a restart of the host and a leader that
 * stays away for days. Two readers:
 *
 *   the copy    the leader's sessions copy may still name such a row as this host's until the
 *               leader applies the channel's record of it; the copy never stores it again
 *               (session-db.ts applySessionCopy), or it would read as an own row born again
 *   rows frame  a leader that gets this host's rows whole deletes only the rows this list names
 *               (rows-snapshot.ts)
 *
 * Bounded: an entry lives MAX_AGE_MS, and the list keeps the newest MAX_ROWS. An own row written
 * again under the same id (the host has it again) leaves the list. Writes are async and in order
 * (tmp file, then rename); a write the process does not finish leaves the file before it.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

export const GONE_MAX_AGE_MS = 14 * 24 * 60 * 60_000
export const GONE_MAX_ROWS = 5_000

export class GoneRows {
  private rows = new Map<string, number>()
  private writing: Promise<void> = Promise.resolve()
  private dirty = false

  private constructor(private readonly file: string, private readonly now: () => number) {}

  static fileOf(dir: string, walnutId: string): string {
    return path.join(dir, `gone-${walnutId}.json`)
  }

  static async open(dir: string, walnutId: string, now: () => number = Date.now): Promise<GoneRows> {
    const g = new GoneRows(GoneRows.fileOf(dir, walnutId), now)
    try {
      const parsed = JSON.parse(await fsp.readFile(g.file, 'utf8')) as { rows?: Record<string, unknown> }
      const at = now()
      const entries = Object.entries(parsed?.rows ?? {})
        .filter((e): e is [string, number] => typeof e[1] === 'number' && at - e[1] < GONE_MAX_AGE_MS)
        .sort((a, b) => a[1] - b[1])
      for (const [sid, t] of entries.slice(-GONE_MAX_ROWS)) g.rows.set(sid, t)
    } catch { /* none yet, or unreadable: an empty list */ }
    return g
  }

  /** The host removed its own row `sid`. */
  note(sid: string): void {
    if (!sid) return
    this.rows.delete(sid)
    if (this.rows.size >= GONE_MAX_ROWS) this.rows.delete(this.rows.keys().next().value!)
    this.rows.set(sid, this.now())
    this.save()
  }

  /** The host has `sid` as an own row again. */
  forget(sid: string): void {
    if (this.rows.delete(sid)) this.save()
  }

  has(sid: string): boolean {
    const at = this.rows.get(sid)
    if (at === undefined) return false
    if (this.now() - at >= GONE_MAX_AGE_MS) { this.rows.delete(sid); this.save(); return false }
    return true
  }

  /** Every row still on the list. */
  list(): string[] {
    const at = this.now()
    return [...this.rows].filter(([, t]) => at - t < GONE_MAX_AGE_MS).map(([sid]) => sid)
  }

  /** The pending write (tests, a stop). */
  flush(): Promise<void> {
    return this.writing
  }

  private save(): void {
    if (this.dirty) return
    this.dirty = true
    this.writing = this.writing.then(async () => {
      this.dirty = false
      const text = JSON.stringify({ v: 1, rows: Object.fromEntries(this.rows) })
      const tmp = `${this.file}.${process.pid}.tmp`
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      await fsp.writeFile(tmp, text, { mode: 0o600 })
      await fsp.rename(tmp, this.file)
    }).catch(() => { /* kept in memory; the next change writes it again */ })
  }
}
