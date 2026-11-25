/**
 * The change watcher's next-read times, kept across restarts (watch.ts).
 *
 * A quiet read (nothing changed) writes no task, so its next read lived only in memory and the
 * snapshot kept the nextAt of the last read that changed something, long past. Every restart made
 * every unsettled change due at once: on 2026-11-23 the Mac restarted 75 times (each land deploys)
 * and 20% of the day's 24,939 reads fell in the three minutes after a boot, with the watcher's
 * section open across the boot's own stalls. The times live in one small file under cache/ (not
 * synced), written after a pass that moved them, at most every SAVE_EVERY_MS (kept-cache-file.ts).
 */

import { log } from '../../logging/index.js'
import { keptCacheFile, readKeptJson } from '../kept-cache-file.js'

const SAVE_EVERY_MS = 10_000

export interface ChangeDueFile {
  load(): Promise<Map<string, number | null>>
  /** Ask for a save of what `read` returns then; several asks inside SAVE_EVERY_MS make one write. */
  save(read: () => ReadonlyMap<string, number | null>): void
  /** Write now what is still to be written (stop). */
  flush(): Promise<void>
}

export function changeDueFile(file: string): ChangeDueFile {
  const kept = keptCacheFile(file, {
    delayMs: SAVE_EVERY_MS,
    onError: (err) => log.task.debug('change-watch: next reads not saved', { error: err instanceof Error ? err.message : String(err) }),
  })
  return {
    async load() {
      const out = new Map<string, number | null>()
      const due = (await readKeptJson(file, 1))?.due
      if (!due || typeof due !== 'object') return out
      for (const [url, at] of Object.entries(due)) {
        if (at === null || (typeof at === 'number' && Number.isFinite(at))) out.set(url, at)
      }
      return out
    },
    save(read) {
      kept.save(() => JSON.stringify({ v: 1, due: Object.fromEntries(read()) }))
    },
    flush: () => kept.flush(),
  }
}
