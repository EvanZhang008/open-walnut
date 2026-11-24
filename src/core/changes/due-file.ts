/**
 * The change watcher's next-read times, kept across restarts (watch.ts).
 *
 * A quiet read (nothing changed) writes no task, so its next read lived only in memory and the
 * snapshot kept the nextAt of the last read that changed something, long past. Every restart made
 * every unsettled change due at once: on 2026-11-23 the Mac restarted 75 times (each land deploys)
 * and 20% of the day's 24,939 reads fell in the three minutes after a boot, with the watcher's
 * section open across the boot's own stalls. The times live in one small file under cache/ (not
 * synced), written after a pass that moved them, at most every SAVE_EVERY_MS.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from '../../logging/index.js'

const SAVE_EVERY_MS = 10_000

export interface ChangeDueFile {
  load(): Promise<Map<string, number | null>>
  /** Ask for a save of what `read` returns then; several asks inside SAVE_EVERY_MS make one write. */
  save(read: () => ReadonlyMap<string, number | null>): void
  /** Write now what is still to be written (stop). */
  flush(): Promise<void>
}

export function changeDueFile(file: string): ChangeDueFile {
  let pending: (() => ReadonlyMap<string, number | null>) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()
  const write = (): Promise<void> => {
    timer = null
    const read = pending
    pending = null
    if (!read) return writing
    const body = JSON.stringify({ v: 1, due: Object.fromEntries(read()) })
    writing = writing.then(async () => {
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp-${process.pid}`
        await fsp.writeFile(tmp, body)
        await fsp.rename(tmp, file)
      } catch (err) {
        log.task.debug('change-watch: next reads not saved', { error: err instanceof Error ? err.message : String(err) })
      }
    })
    return writing
  }
  return {
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { v?: number; due?: Record<string, unknown> }
        const out = new Map<string, number | null>()
        if (parsed?.v !== 1 || !parsed.due || typeof parsed.due !== 'object') return out
        for (const [url, at] of Object.entries(parsed.due)) {
          if (at === null || (typeof at === 'number' && Number.isFinite(at))) out.set(url, at)
        }
        return out
      } catch {
        return new Map()
      }
    },
    save(read) {
      pending = read
      if (timer) return
      timer = setTimeout(() => { void write() }, SAVE_EVERY_MS)
      timer.unref?.()
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      await write()
    },
  }
}
