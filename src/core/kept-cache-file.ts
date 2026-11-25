/**
 * A memory cache kept on disk across restarts, under WALNUT_HOME/cache/ (not synced).
 *
 * The server restarts about 70 times a day here (every land deploys), and each restart emptied
 * the caches that save a host's link its transfers. A cache that should survive one keeps a copy
 * through this module:
 *  - writes are coalesced: asks within `delayMs` make one write, of the state as it is when the
 *    write runs, so a cache that changes every second writes at most once per `delayMs`;
 *  - a write is whole or absent: a temp file with a unique name, then a rename;
 *  - stop flushes what is still asked (the caller bounds the wait, see shutdown-steps.ts);
 *  - a file that does not parse or carries another version reads as none, never an error.
 *
 * Users: the change watcher's next reads (changes/due-file.ts) and the slash palette's host scans
 * (web/routes/slash-commands-disk.ts). The history tail windows (history-tail-window-disk.ts)
 * append to their files instead, so they have a writer of their own.
 * A copy read back is only a hint: each user validates it against the source before it answers.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ATOMIC_TEMP_RE, writeFileAtomic } from './config-file-io.js'

export type KeptFileBody = string | Uint8Array

export interface KeptCacheFile {
  /** Ask for a write of what `body` returns when the write runs (undefined: nothing to write then). */
  save(body: () => KeptFileBody | undefined): void
  /** Write now what is asked and not yet written; resolves when every write asked so far is done. */
  flush(): Promise<void>
  /** Forget what is asked and remove the file (after a write already running). */
  remove(): Promise<void>
  /** A write is asked and not yet started. */
  readonly pending: boolean
}

export function keptCacheFile(
  file: string,
  opts: { delayMs: number; onError: (err: unknown) => void; onWritten?: (bytes: number) => void },
): KeptCacheFile {
  let asked: (() => KeptFileBody | undefined) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<void> = Promise.resolve()
  const stopTimer = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
  }
  const run = (): Promise<void> => {
    stopTimer()
    const body = asked
    asked = null
    if (!body) return chain
    chain = chain.then(async () => {
      try {
        const data = body()
        if (data === undefined) return
        await fsp.mkdir(path.dirname(file), { recursive: true })
        await writeFileAtomic(file, data)
        opts.onWritten?.(typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength)
      } catch (err) {
        opts.onError(err)
      }
    })
    return chain
  }
  return {
    save(body) {
      asked = body
      if (timer) return
      timer = setTimeout(() => { void run() }, opts.delayMs)
      timer.unref?.()
    },
    flush: run,
    remove() {
      asked = null
      stopTimer()
      chain = chain.then(() => fsp.rm(file, { force: true })).catch(opts.onError)
      return chain
    },
    get pending() { return asked !== null },
  }
}

/**
 * The JSON body of a kept file when it carries `{ v: version }`; null when the file is missing,
 * does not parse, or is of another version (an older or newer Walnut's: ignored, never fatal).
 */
export async function readKeptJson(file: string, version: number): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const body = parsed as Record<string, unknown>
    return body.v === version ? body : null
  } catch {
    return null
  }
}

/** A temp this old belongs to no write still running (another process's included). */
const STALE_TEMP_MS = 10 * 60_000

/** Remove the write temps of `file` a crash or a cut-short stop left beside it (boot). Never throws. */
export async function removeStaleTemps(file: string): Promise<void> {
  const dir = path.dirname(file)
  const base = path.basename(file)
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (ATOMIC_TEMP_RE.exec(name)?.[1] !== base) continue
    const at = path.join(dir, name)
    const st = await fsp.stat(at).catch(() => null)
    if (st && Date.now() - st.mtimeMs > STALE_TEMP_MS) await fsp.rm(at, { force: true }).catch(() => {})
  }
}

/**
 * One part of a JSON kept file that holds several caches (the slash palette's file): what to
 * write, how to take back what a previous process wrote, and a hook to ask for a write.
 */
export interface KeptSection {
  /** The part as it should be written now (JSON-able). */
  forDisk(): unknown
  /** Take back a part read from disk (anything: the section checks its shape). */
  restore(data: Promise<unknown>): Promise<void>
  /** `changed` is called whenever the part changed and should be written. */
  onChange(changed: () => void): void
}
