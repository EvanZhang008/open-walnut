/**
 * One stage's steps and blockers when the card opens it (GET /api/tasks/:id/changes/stage), read
 * live from the change's provider: cached a minute per (URL, stage), one read at a time for each
 * (a second ask while one runs joins it), and never past its deadline.
 */

import type { ChangeLink, ChangeStageDetail } from './model.js'
import { changeProviderFor } from './registry.js'
import { ensureCoreChangeProviders } from './github.js'
import { abortableDeadline } from './deadline.js'

const TTL_MS = 60_000
const CACHE_MAX = 200
const deadline = { ms: 15_000 }

type Answer = { detail: ChangeStageDetail | null; error?: string }
type Entry = { at: number; value: Answer } | { pending: Promise<Answer> }
const cache = new Map<string, Entry>()

/** Make room by dropping the oldest finished entry; a read still running is never dropped. */
function makeRoom(): void {
  if (cache.size < CACHE_MAX) return
  for (const [key, entry] of cache) {
    if (!('pending' in entry)) { cache.delete(key); return }
  }
}

export async function changeStageDetail(link: ChangeLink, stage: string, now = Date.now()): Promise<Answer> {
  ensureCoreChangeProviders()
  const provider = changeProviderFor(link)
  if (!provider) return { detail: null, error: 'no-provider' }
  if (!provider.stageDetail) return { detail: null }
  const key = `${link.url}\n${stage}`
  const hit = cache.get(key)
  if (hit && 'pending' in hit) return hit.pending
  if (hit && now - hit.at < TTL_MS) return hit.value
  const pending: Promise<Answer> = abortableDeadline(deadline.ms, (signal) => provider.stageDetail!(link, stage, { signal })).then(
    (detail) => {
      const value = { detail: detail ?? null }
      if (cache.get(key) === entry) cache.set(key, { at: Date.now(), value })
      return value
    },
    (err) => {
      if (cache.get(key) === entry) cache.delete(key)
      const message = err instanceof Error ? err.message : String(err)
      return { detail: null, error: message }
    },
  )
  const entry: Entry = { pending }
  cache.delete(key)
  makeRoom()
  cache.set(key, entry)
  return pending
}

/** For tests. */
export function _resetStageDetailForTesting(ms = 15_000): void {
  cache.clear()
  deadline.ms = ms
}
