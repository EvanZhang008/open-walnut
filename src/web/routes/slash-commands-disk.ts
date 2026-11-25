/**
 * The slash palette's caches kept across restarts: one file, WALNUT_HOME/cache/slash-palette.json
 * (not synced), read back after the boot and written at most every SAVE_EVERY_MS.
 *
 * Without it, each restart (about 70 a day, one per land) emptied the per-host scans and the
 * stream looks, so the first palette of every remote session after a deploy waited out the
 * 1.5 s budget and often answered without the host's commands. Kept parts (KeptSection each):
 *  - `skills`: a host's user skills, per host (PaletteScanCache, with their scan time);
 *  - `project`: a host folder's project commands and skills (the same);
 *  - `streams`: where the last look at each session's stream stopped and the names it found
 *    (cli-slash-commands-recover.ts), so the next recovery reads only what the stream gained.
 * What is read back is never trusted as fresh: a scan keeps its age and goes through the same
 * stale-while-revalidate path, and a stream look answers only for the same file incarnation.
 * A file that does not parse or is of another version reads as empty; an older Walnut never
 * reads this file.
 */
import path from 'node:path'
import { log } from '../../logging/index.js'
import { keptCacheFile, readKeptJson, removeStaleTemps, type KeptCacheFile, type KeptSection } from '../../core/kept-cache-file.js'

const VERSION = 1
/** Asks inside this make one write. */
export const PALETTE_SAVE_EVERY_MS = 10_000
/** A body over this is not written (the caps keep it far under: a few hundred KB). */
const MAX_FILE_BYTES = 8 * 1024 * 1024

let kept: { file: KeptCacheFile; sections: Record<string, KeptSection> } | null = null

/** The kept file's place: WALNUT_HOME/cache/slash-palette.json. */
export async function paletteDiskFile(): Promise<string> {
  const { WALNUT_HOME } = await import('../../constants.js')
  return path.join(WALNUT_HOME, 'cache', 'slash-palette.json')
}

/**
 * Read the kept parts back into `sections` (each waits for its own while it reads), and write
 * them from now on whenever one changes. Once per process; resolves when every part is back.
 */
export async function startPaletteDisk(sections: Record<string, KeptSection>, file?: string): Promise<void> {
  if (kept) return
  const at = file ?? await paletteDiskFile()
  const out = keptCacheFile(at, {
    delayMs: PALETTE_SAVE_EVERY_MS,
    onError: (err) => log.web.debug('slash-commands: palette cache not saved', { error: err instanceof Error ? err.message : String(err) }),
  })
  kept = { file: out, sections }
  const save = (): void => out.save(() => {
    const body = JSON.stringify({ v: VERSION, ...Object.fromEntries(Object.entries(sections).map(([name, s]) => [name, s.forDisk()])) })
    const bytes = Buffer.byteLength(body)
    if (bytes <= MAX_FILE_BYTES) return body
    log.web.warn('slash-commands: palette cache too big to keep, not saved', { bytes })
    return undefined
  })
  for (const s of Object.values(sections)) s.onChange(save)
  const loaded = readKeptJson(at, VERSION)
  // The write temps a crash or a cut-short stop left beside the file go (they never read back).
  await removeStaleTemps(at)
  await Promise.all(Object.entries(sections).map(([name, s]) => s.restore(loaded.then((body) => body?.[name]))))
}

/** Write now what is asked (server stop; the caller bounds the wait). */
export async function flushPaletteDisk(): Promise<void> {
  await kept?.file.flush()
}

/** Test seam: forget the kept file (the next start reads it again, as a new process does). */
export function _stopPaletteDiskForTesting(): void {
  if (!kept) return
  for (const s of Object.values(kept.sections)) s.onChange(() => {})
  kept = null
}
