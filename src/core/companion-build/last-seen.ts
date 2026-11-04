/**
 * The build the cloud companion was last seen running, and when, kept on disk
 * (WALNUT_HOME/cache/companion-build-seen.json) so a restart of this server shows
 * it at once instead of "checking" until the first look (mac.ts seeds its view
 * from it; the next look replaces it). Its own file: the gave-up record
 * (companion-build.json) is rewritten whole by its own writer.
 */

import fs from 'node:fs'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { validBuildId } from './wire.js'

/** `origin`: the companion it was read from (its endpoint's origin): another box never shows it. */
export interface LastSeen { theirs: string; at: number; origin: string }

/** A sighting of the same build is written again at most this often (its age stays honest enough). */
const REWRITE_MS = 60_000

export function createLastSeenRecord(file: () => string) {
  let written: LastSeen | null = null
  let writing: Promise<void> = Promise.resolve()
  return {
    async read(): Promise<LastSeen | null> {
      try {
        const raw = JSON.parse(await fs.promises.readFile(file(), 'utf8')) as Partial<LastSeen>
        if (typeof raw.theirs !== 'string' || !validBuildId(raw.theirs) || typeof raw.at !== 'number' || !(raw.at > 0)) return null
        if (typeof raw.origin !== 'string' || !raw.origin) return null
        written = { theirs: raw.theirs, at: raw.at, origin: raw.origin }
        return written
      } catch {
        return null
      }
    },
    /** Remember a sighting; same build within REWRITE_MS: no write. Never rejects. */
    write(seen: LastSeen): Promise<void> {
      if (written && written.theirs === seen.theirs && written.origin === seen.origin && seen.at - written.at < REWRITE_MS) return writing
      written = seen
      writing = writing.then(async () => {
        const target = file()
        const tmp = `${target}.tmp-${process.pid}`
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        await fs.promises.writeFile(tmp, JSON.stringify(seen))
        await fs.promises.rename(tmp, target)
      }).catch((err) => {
        log.session.warn('companion build: could not save the build last seen', { error: err instanceof Error ? err.message : String(err) })
      })
      return writing
    },
    settled: (): Promise<void> => writing,
    forget(): void { written = null },
  }
}
